import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('./fetch-utils', () => ({
  fetchUpstream: (...args: unknown[]) => mockFetch(...args),
}));

/**
 * 每个用例都重新加载模块：`getMangaTags` 有 12 小时的模块级缓存，
 * 不重置会让用例之间互相污染。
 */
async function loadModule() {
  vi.resetModules();
  return import('./mangadex');
}

const UUID_1 = '391b0423-d847-456f-aff0-8b0cfc03066b';
const UUID_2 = 'b11fda93-b6e8-4a1e-9b7c-0f3c5d2e4a77';

/** 一条 MangaDex 原始条目 */
function manga(id: string, title: Record<string, string>): Record<string, unknown> {
  return {
    id,
    attributes: { title, contentRating: 'safe', tags: [], status: 'ongoing', year: 2021 },
    relationships: [{ type: 'cover_art', id: 'cov', attributes: { fileName: 'a.jpg' } }],
  };
}

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

/** `/manga/tag` 的返回体：含两个需要硬排除的标签 */
const TAG_PAYLOAD = {
  data: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', attributes: { name: { en: 'Action' }, group: 'genre' } },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', attributes: { name: { en: 'Loli' }, group: 'theme' } },
    { id: 'cccccccc-0000-4000-8000-000000000003', attributes: { name: { en: 'Shota' }, group: 'theme' } },
    { id: 'dddddddd-0000-4000-8000-000000000004', attributes: { name: { en: 'Incest' }, group: 'theme' } },
  ],
};

const BLOCKED_IDS = [
  'bbbbbbbb-0000-4000-8000-000000000002',
  'cccccccc-0000-4000-8000-000000000003',
  'dddddddd-0000-4000-8000-000000000004',
];

beforeEach(() => {
  mockFetch.mockReset();
});

describe('漫画标题取值', () => {
  it('没有 en 标题时回落到罗马音（热门作品实测 100% 只有 ja-ro）', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({ data: [manga('m1', { 'ja-ro': 'Kage no Jitsuryokusha ni Naritakute!' })], total: 1 })
    );
    const { items } = await browseManga({});
    expect(items[0].title).toBe('Kage no Jitsuryokusha ni Naritakute!');
  });

  it('中文字段优先于罗马音', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockResolvedValue(okJson({ data: [manga('m1', { 'ja-ro': 'Romaji', zh: '中文名' })], total: 1 }));
    const { items } = await browseManga({});
    expect(items[0].title).toBe('中文名');
  });

  it('任何已知语言都没有时，取第一个非空值而不是空标题', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockResolvedValue(okJson({ data: [manga('m1', { xx: 'Something' })], total: 1 }));
    const { items } = await browseManga({});
    expect(items[0].title).toBe('Something');
  });
});

describe('browseManga 参数构造', () => {
  /**
   * 调用一次并回传拼出的**漫画列表**请求 URL。
   *
   * 一次浏览会打两个上游请求：先 `/manga/tag`（取要硬排除的标签 id），
   * 再 `/manga`。所以这里要按 URL 区分，取后者。
   */
  async function callUrl(params: Record<string, unknown>): Promise<string> {
    const { browseManga } = await loadModule();
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url).includes('/manga/tag') ? okJson(TAG_PAYLOAD) : okJson({ data: [], total: 0 })
    );
    await browseManga(params);
    return lastMangaUrl();
  }

  /** 最后一次非标签请求的 URL */
  function lastMangaUrl(): string {
    const calls = mockFetch.mock.calls.filter((c) => !String(c[0]).includes('/manga/tag'));
    return calls[calls.length - 1][0] as string;
  }

  it('默认按最新更新排序，且不含成人分级', async () => {
    const url = await callUrl({});
    expect(url).toContain('order%5BlatestUploadedChapter%5D=desc');
    expect(url).toContain('contentRating%5B%5D=safe');
    expect(url).toContain('contentRating%5B%5D=suggestive');
    expect(url).not.toContain('erotica');
  });

  it('sort=popular 用 followedCount 排序', async () => {
    expect(await callUrl({ sort: 'popular' })).toContain('order%5BfollowedCount%5D=desc');
  });

  it('sort=rating / newest 各自对应上游字段', async () => {
    expect(await callUrl({ sort: 'rating' })).toContain('order%5Brating%5D=desc');
    expect(await callUrl({ sort: 'newest' })).toContain('order%5BcreatedAt%5D=desc');
  });

  it('未知 sort 回落 latest，不把垃圾值拼进 URL', async () => {
    expect(await callUrl({ sort: 'bogus' })).toContain('order%5BlatestUploadedChapter%5D=desc');
  });

  it('多个标签取 AND', async () => {
    const url = await callUrl({ tags: [UUID_1, UUID_2] });
    expect(url).toContain(`includedTags%5B%5D=${UUID_1}`);
    expect(url).toContain(`includedTags%5B%5D=${UUID_2}`);
    expect(url).toContain('includedTagsMode=AND');
  });

  it('单个标签不加 AND 模式（单个标签无歧义）', async () => {
    const url = await callUrl({ tags: [UUID_1] });
    expect(url).toContain(`includedTags%5B%5D=${UUID_1}`);
    expect(url).not.toContain('includedTagsMode');
  });

  it('非 UUID 的标签被丢弃（防任意字符串进上游 URL）', async () => {
    const url = await callUrl({ tags: [UUID_1, '../../etc/passwd', 'x'] });
    expect(url).toContain(`includedTags%5B%5D=${UUID_1}`);
    expect(url).not.toContain('passwd');
    expect(url).not.toContain('includedTags%5B%5D=x');
  });

  it('受众 / 状态 / 语言走各自的上游参数', async () => {
    const url = await callUrl({ demographic: 'shounen', status: 'ongoing', language: 'zh' });
    expect(url).toContain('publicationDemographic%5B%5D=shounen');
    expect(url).toContain('status%5B%5D=ongoing');
    expect(url).toContain('availableTranslatedLanguage%5B%5D=zh');
  });

  it('非白名单的受众 / 状态 / 语言不进 URL', async () => {
    const url = await callUrl({
      demographic: 'shounen OR 1=1',
      status: 'bogus',
      language: 'klingon',
    });
    expect(url).not.toContain('publicationDemographic');
    expect(url).not.toContain('status%5B%5D');
    expect(url).not.toContain('availableTranslatedLanguage');
  });

  it('默认不放开成人档位，includeAdult 只到 erotica', async () => {
    expect(await callUrl({})).not.toContain('erotica');
    const url = await callUrl({ includeAdult: true });
    expect(url).toContain('contentRating%5B%5D=erotica');
    expect(url).not.toContain('pornographic');
  });

  it('rating 档位向下累积，未知档位退回默认', async () => {
    const erotica = await callUrl({ rating: 'erotica' });
    expect(erotica).toContain('contentRating%5B%5D=erotica');
    expect(erotica).not.toContain('pornographic');

    const porn = await callUrl({ rating: 'pornographic' });
    expect(porn).toContain('contentRating%5B%5D=erotica');
    expect(porn).toContain('contentRating%5B%5D=pornographic');

    expect(await callUrl({ rating: 'bogus' })).not.toContain('erotica');
  });

  it('放开限制级时未成年性化题材依然被硬排除', async () => {
    const url = await callUrl({ rating: 'pornographic' });
    for (const id of BLOCKED_IDS) {
      expect(url).toContain(`excludedTags%5B%5D=${id}`);
    }
    expect(url).toContain('excludedTagsMode=OR');
  });

  it('原作地区走 originalLanguage[]，非白名单值不进 URL', async () => {
    expect(await callUrl({ origin: 'ko' })).toContain('originalLanguage%5B%5D=ko');
    expect(await callUrl({ origin: 'klingon' })).not.toContain('originalLanguage');
  });

  it('总是把未成年性化题材放进 excludedTags，且用 OR 模式排除', async () => {
    const url = await callUrl({});
    for (const id of BLOCKED_IDS) {
      expect(url).toContain(`excludedTags%5B%5D=${id}`);
    }
    expect(url).toContain('excludedTagsMode=OR');
  });

  it('标签表拿不到时不阻断列表（只靠事后兜底过滤）', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/manga/tag')) return { ok: false, status: 500, json: async () => ({}) };
      return okJson({ data: [manga('m1', { en: 'A' })], total: 1 });
    });
    const { items } = await browseManga({});
    expect(items).toHaveLength(1);
  });

  it('事后兜底：上游漏返回时，带被排除标签的作品仍会被剔除', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockClear();
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/manga/tag')) return okJson(TAG_PAYLOAD);
      // 模拟上游 excludedTags 失效：把违规作品一并返回
      const bad = manga('bad', { en: 'Bad' }) as { attributes: Record<string, unknown> };
      bad.attributes.tags = [{ id: BLOCKED_IDS[0], attributes: { name: { en: 'Loli' }, group: 'theme' } }];
      return okJson({ data: [manga('good', { en: 'Good' }), bad], total: 2 });
    });
    const { items } = await browseManga({});
    expect(items.map((i) => i.id)).toEqual(['good']);
  });

  it('limit 上限 100，负 offset 归零', async () => {
    const url = await callUrl({ limit: 9999, offset: -5 });
    expect(url).toContain('limit=100');
    expect(url).toContain('offset=0');
  });

  it('总是带 cover_art 关系，封面拼成 uploads 地址', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockResolvedValue(okJson({ data: [manga('m1', { en: 'A' })], total: 1 }));
    const { items } = await browseManga({});
    const urls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes('/manga/tag'));
    expect(urls[0]).toContain('includes%5B%5D=cover_art');
    expect(items[0].cover).toBe('https://uploads.mangadex.org/covers/m1/a.jpg');
  });

  it('上游非 2xx 时抛出可读错误', async () => {
    const { browseManga } = await loadModule();
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(browseManga({})).rejects.toThrow(/503/);
  });
});

describe('getMangaTags', () => {
  const tagPayload = {
    data: [
      { id: 't1', attributes: { name: { en: 'Action' }, group: 'genre' } },
      { id: 't2', attributes: { name: { en: 'Romance' }, group: 'genre' } },
      { id: 't3', attributes: { name: { en: 'School Life' }, group: 'theme' } },
      // 下面三个不该成为分类入口
      { id: 't4', attributes: { name: { en: 'Loli' }, group: 'theme' } },
      { id: 't5', attributes: { name: { en: 'Incest' }, group: 'theme' } },
      { id: 't6', attributes: { name: { en: 'Gore' }, group: 'content' } },
      { id: 't7', attributes: { name: { en: 'Oneshot' }, group: 'format' } },
    ],
  };

  it('按 group 分组、带中文名，并剔除不适合的分类入口', async () => {
    const { getMangaTags } = await loadModule();
    mockFetch.mockResolvedValue(okJson(tagPayload));

    const { groups } = await getMangaTags();

    expect(groups.find((g) => g.group === 'genre')?.tags.map((t) => t.zh)).toEqual(['动作', '恋爱']);
    expect(groups.find((g) => g.group === 'theme')?.tags.map((t) => t.zh)).toEqual(['校园']);
    expect(groups.find((g) => g.group === 'format')?.tags.map((t) => t.zh)).toEqual(['单篇']);

    // content 组整体不展示
    expect(groups.map((g) => g.group)).toEqual(['genre', 'theme', 'format']);

    const dump = JSON.stringify(groups);
    expect(dump).not.toContain('Loli');
    expect(dump).not.toContain('Incest');
    expect(dump).not.toContain('Gore');
  });

  it('未收录的标签回落英文原名，不会丢标签', async () => {
    const { getMangaTags } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({
        data: [{ id: 'z1', attributes: { name: { en: 'Some Brand New Tag' }, group: 'genre' } }],
      })
    );
    const { groups } = await getMangaTags();
    expect(groups[0].tags[0]).toEqual({ id: 'z1', name: 'Some Brand New Tag', zh: 'Some Brand New Tag' });
  });

  it('缓存命中时不再请求上游', async () => {
    const { getMangaTags } = await loadModule();
    mockFetch.mockResolvedValue(okJson(tagPayload));
    await getMangaTags();
    const first = mockFetch.mock.calls.length;
    await getMangaTags();
    expect(mockFetch.mock.calls.length).toBe(first);
  });

  it('上游失败且无缓存时抛错', async () => {
    const { getMangaTags } = await loadModule();
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(getMangaTags()).rejects.toThrow(/500/);
  });

  it('上游失败但有缓存时降级返回旧标签，不让筛选区空掉', async () => {
    const { getMangaTags } = await loadModule();
    mockFetch.mockResolvedValue(okJson(tagPayload));
    const first = await getMangaTags();

    mockFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const second = await getMangaTags();
    expect(second).toEqual(first);
  });
});

describe('章节接口的分级参数', () => {
  /** 抓下实际请求的 URL，并返回一个非空章节列表 */
  async function feedUrl(opts: Record<string, unknown>): Promise<string> {
    const { getChapters } = await loadModule();
    let url = '';
    mockFetch.mockImplementation(async (u: unknown) => {
      url = String(u);
      return okJson({
        data: [{ id: 'c1', attributes: { chapter: '1', translatedLanguage: 'zh', pages: 10 } }],
        total: 1,
      });
    });
    await getChapters(UUID_1, opts as never);
    return url;
  }

  it('限制级档位会带到 feed，否则上游直接返回 0 章', async () => {
    const url = await feedUrl({ rating: 'pornographic' });
    expect(url).toContain('contentRating%5B%5D=erotica');
    expect(url).toContain('contentRating%5B%5D=pornographic');
  });

  it('不传档位时 feed 只带 safe + suggestive', async () => {
    const url = await feedUrl({});
    expect(url).toContain('contentRating%5B%5D=safe');
    expect(url).not.toContain('pornographic');
    expect(url).not.toContain('erotica');
  });
});
