import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('./fetch-utils', () => ({
  fetchUpstream: (...args: unknown[]) => mockFetch(...args),
}));

/** 每次重新加载，避免模块级状态污染 */
async function loadModule() {
  vi.resetModules();
  return import('./zaimanhua');
}

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

beforeEach(() => {
  mockFetch.mockReset();
});

/** 调一次并回传拼出的上游 URL */
async function callUrl(fn: () => Promise<unknown>): Promise<string> {
  mockFetch.mockResolvedValue(okJson({ errno: 0, data: {} }));
  await fn();
  return mockFetch.mock.calls[0][0] as string;
}

describe('再漫画章节 id 编解码', () => {
  it('encode → decode 往返一致', async () => {
    const { encodeZaiChapter, decodeZaiChapter } = await loadModule();
    const key = encodeZaiChapter('85969', '188972');
    expect(key).toBe('z85969.188972');
    expect(decodeZaiChapter(key)).toEqual({ comicId: '85969', chapterId: '188972' });
  });

  it('非再漫画格式（MangaDex 的 UUID）解出来是 null', async () => {
    const { decodeZaiChapter } = await loadModule();
    expect(decodeZaiChapter('391b0423-d847-456f-aff0-8b0cfc03066b')).toBeNull();
  });

  it('拒绝把任意字符串当成章节 id（防 SSRF 式的路径注入）', async () => {
    const { decodeZaiChapter } = await loadModule();
    expect(decodeZaiChapter('z85969.188972/../../etc/passwd')).toBeNull();
    expect(decodeZaiChapter('zabc.def')).toBeNull();
  });

  it('isZaiComicId 只认纯数字', async () => {
    const { isZaiComicId } = await loadModule();
    expect(isZaiComicId('85969')).toBe(true);
    expect(isZaiComicId('391b0423-d847-456f-aff0-8b0cfc03066b')).toBe(false);
  });
});

describe('再漫画筛选参数', () => {
  it('只放行白名单内的取值，非法值回落 0', async () => {
    const { browseZaimanhua } = await loadModule();
    const url = await callUrl(() =>
      browseZaimanhua({ theme: '5848', zone: '../../etc', cate: '3262', status: '999999', sort: 'popular' })
    );
    const sp = new URLSearchParams(url.split('?')[1]);
    expect(sp.get('theme')).toBe('5848');
    expect(sp.get('zone')).toBe('0'); // 非法
    expect(sp.get('cate')).toBe('3262');
    expect(sp.get('status')).toBe('0'); // 不在表里
    expect(sp.get('sortType')).toBe('2'); // popular
  });

  it('默认全部为 0、排序为最近更新', async () => {
    const { browseZaimanhua } = await loadModule();
    const url = await callUrl(() => browseZaimanhua({}));
    const sp = new URLSearchParams(url.split('?')[1]);
    expect(sp.get('theme')).toBe('0');
    expect(sp.get('zone')).toBe('0');
    expect(sp.get('sortType')).toBe('1');
    expect(sp.get('page')).toBe('1');
  });

  it('走的是 filter/list 而不是 update/list（后者的分类参数上游不生效）', async () => {
    const { browseZaimanhua } = await loadModule();
    const url = await callUrl(() => browseZaimanhua({ theme: '5848' }));
    expect(url).toContain('comic/filter/list');
    expect(url).not.toContain('comic/update/list');
  });

  it('搜索参数名是 keyword 而不是 q（写错上游会报「请输入搜索的内容」）', async () => {
    const { searchZaimanhua } = await loadModule();
    const url = await callUrl(() => searchZaimanhua('一人', { page: 2 }));
    expect(url).toContain('search/index?keyword=');
    expect(url).toContain('page=2');
  });
});

describe('再漫画字段兼容（三个接口给的字段名不一样）', () => {
  it('filter/list 用 name，search 用 title，两者都要能取到', async () => {
    const { browseZaimanhua, searchZaimanhua } = await loadModule();

    mockFetch.mockResolvedValue(
      okJson({ errno: 0, data: { comicList: [{ id: 1, name: '来自 filter/list', types: '奇幻' }], totalNum: 1 } })
    );
    const browsed = await browseZaimanhua({});
    expect(browsed.items[0].title).toBe('来自 filter/list');

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      okJson({ errno: 0, data: { list: [{ comic_id: 2, title: '来自 search' }], total: 1 } })
    );
    const searched = await searchZaimanhua('x');
    expect(searched.items[0].title).toBe('来自 search');
  });

  it('列表里的漫画 id 取 comic_id 与 id 中非 0 的那个', async () => {
    const { searchZaimanhua } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({
        errno: 0,
        // 实测两种形态都存在：search 里 id 有值 comic_id=0，update/list 里相反
        data: { list: [{ id: 15452, comic_id: 0, title: 'A' }, { id: 0, comic_id: 85969, title: 'B' }] },
      })
    );
    const { items } = await searchZaimanhua('x');
    expect(items.map((i) => i.id)).toEqual(['15452', '85969']);
  });

  it('题材：列表给逗号字符串，详情给对象数组，都要解析出 id', async () => {
    const { browseZaimanhua, getZaimanhuaDetail } = await loadModule();

    mockFetch.mockResolvedValue(
      okJson({ errno: 0, data: { comicList: [{ id: 1, name: 'A', types: '奇幻,日常' }], totalNum: 1 } })
    );
    const browsed = await browseZaimanhua({});
    // 中文名要映射到题材 id，否则点标签跳分类会被白名单挡掉
    expect(browsed.items[0].tags).toEqual([
      { id: '5848', name: '奇幻', group: 'genre' },
      { id: '30788', name: '日常', group: 'genre' },
    ]);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      okJson({
        errno: 0,
        data: {
          data: {
            id: 1,
            title: 'A',
            types: [{ tag_id: 5848, tag_name: '奇幻' }],
            status: [{ tag_id: 2309, tag_name: '连载中' }],
            authors: [{ tag_id: 1, tag_name: '由田果' }],
          },
        },
      })
    );
    const { item } = await getZaimanhuaDetail('1');
    expect(item.tags[0]).toEqual({ id: '5848', name: '奇幻', group: 'genre' });
    expect(item.status).toBe('连载中');
    expect(item.authors).toEqual(['由田果']);
  });

  it('章节图片在 data.data.page_url（双层 data，少读一层会拿到空数组）', async () => {
    const { getZaimanhuaChapterPages } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({
        errno: 0,
        data: { data: { page_url: ['https://images.zaimanhua.com/a.jpg?sign=x'] } },
      })
    );
    const urls = await getZaimanhuaChapterPages('85969', '188972');
    expect(urls).toEqual(['https://images.zaimanhua.com/a.jpg?sign=x']);
  });

  it('只保留 https 图片地址', async () => {
    const { getZaimanhuaChapterPages } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({
        errno: 0,
        data: { data: { page_url: ['https://ok.jpg', 'http://plain.jpg', 'javascript:alert(1)'] } },
      })
    );
    const urls = await getZaimanhuaChapterPages('1', '2');
    expect(urls).toEqual(['https://ok.jpg']);
  });

  it('章节按话数升序，并把 chapter_title 的「20话」取成 20', async () => {
    const { getZaimanhuaDetail } = await loadModule();
    mockFetch.mockResolvedValue(
      okJson({
        errno: 0,
        data: {
          data: {
            id: 5,
            title: 'T',
            chapters: [
              {
                title: '连载',
                data: [
                  { chapter_id: 30, chapter_title: '3话', chapter_name: '第3话' },
                  { chapter_id: 10, chapter_title: '1话', chapter_name: '第1话' },
                  { chapter_id: 20, chapter_title: '2话', chapter_name: '第2话' },
                ],
              },
            ],
          },
        },
      })
    );
    const { chapters } = await getZaimanhuaDetail('5');
    expect(chapters.map((c) => c.number)).toEqual(['1', '2', '3']);
    // 章节 id 带漫画 id，阅读器只靠它就能反解出该请求哪个源
    expect(chapters[0].id).toBe('z5.10');
  });
});

describe('搜索结果剔除已下架条目', () => {
  /** 按 URL 区分响应：搜索接口返回列表，详情接口逐条判定是否存在 */
  function mockSearchThenDetail(exists: Record<string, boolean>) {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('search/index')) {
        return okJson({
          errno: 0,
          data: {
            list: Object.keys(exists).map((id) => ({ id: Number(id), comic_id: 0, title: `T${id}` })),
            total: Object.keys(exists).length,
          },
        });
      }
      const id = u.match(/comic\/detail\/(\d+)/)?.[1] ?? '';
      return exists[id]
        ? okJson({ errno: 0, data: { data: { id: Number(id), title: `T${id}`, chapters: [] } } })
        : okJson({ errno: 2, errmsg: '漫画不存在或已被删除', data: {} });
    });
  }

  it('上游已下架的条目不出现在搜索结果里', async () => {
    const { searchZaimanhua } = await loadModule();
    mockSearchThenDetail({ '1': true, '2': false, '3': true });
    const { items } = await searchZaimanhua('龙');
    expect(items.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('全部下架时退回原列表，不假装「没有找到」', async () => {
    const { searchZaimanhua } = await loadModule();
    mockSearchThenDetail({ '1': false, '2': false });
    const { items } = await searchZaimanhua('龙');
    expect(items.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('验证请求本身失败时保守保留（不该因网络抖动搜不到东西）', async () => {
    const { searchZaimanhua } = await loadModule();
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('search/index')) {
        return okJson({ errno: 0, data: { list: [{ id: 1, comic_id: 0, title: 'A' }], total: 1 } });
      }
      throw new Error('network down');
    });
    const { items } = await searchZaimanhua('龙');
    expect(items.map((i) => i.id)).toEqual(['1']);
  });
});

describe('再漫画错误处理', () => {
  it('errno 非 0 时抛出上游给的中文原因', async () => {
    const { searchZaimanhua } = await loadModule();
    mockFetch.mockResolvedValue(okJson({ errno: 1, errmsg: '请输入搜索的内容', data: {} }));
    await expect(searchZaimanhua('x')).rejects.toThrow('请输入搜索的内容');
  });

  it('详情 id 非法时直接拒绝，不打到上游', async () => {
    const { getZaimanhuaDetail } = await loadModule();
    await expect(getZaimanhuaDetail('abc')).rejects.toThrow('再漫画 id 非法');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('源分发', () => {
  it('UUID → MangaDex，纯数字 → 再漫画', async () => {
    const { detectMangaSource } = await import('./manga-sources');
    expect(detectMangaSource('391b0423-d847-456f-aff0-8b0cfc03066b')).toBe('mangadex');
    expect(detectMangaSource('85969')).toBe('zaimanhua');
  });

  it('章节 id 带 z 前缀 → 再漫画', async () => {
    const { detectChapterSource } = await import('./manga-sources');
    expect(detectChapterSource('z85969.188972')).toBe('zaimanhua');
    expect(detectChapterSource('391b0423-d847-456f-aff0-8b0cfc03066b')).toBe('mangadex');
  });

  it('未知 source 参数回落默认源（再漫画）', async () => {
    const { resolveMangaSource } = await import('./manga-source-meta');
    expect(resolveMangaSource(null)).toBe('zaimanhua');
    expect(resolveMangaSource('mangadex')).toBe('mangadex');
    expect(resolveMangaSource('MXJSUAHD')).toBe('zaimanhua');
  });

  it('再漫画的图片走统一入口，直接给完整 URL', async () => {
    const { getChapterImageUrls } = await import('./manga-sources');
    mockFetch.mockResolvedValue(
      okJson({ errno: 0, data: { data: { page_url: ['https://images.zaimanhua.com/1.jpg'] } } })
    );
    const urls = await getChapterImageUrls('z85969.188972');
    expect(urls).toEqual(['https://images.zaimanhua.com/1.jpg']);
  });
});
