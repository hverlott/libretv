import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 编排层单测：不联网，用注入的 fetcher 回放豆瓣/TMDB 的真实响应结构。
 *
 * 每个用例都 resetModules 重建模块：限流器与缓存是模块级单例，
 * 不重置的话「冷却」状态会在用例之间串味。
 */

interface FakeResponse {
  status: number;
  body: unknown;
}

const ENV_KEYS = ['RATING_PROVIDER', 'TMDB_API_KEY', 'TMDB_API_BASE', 'RATING_DOUBAN', 'RATING_PERSIST'];

let calls: string[] = [];
let handler: (url: string) => FakeResponse = () => ({ status: 200, body: { items: [] } });

function makeFetcher(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function setup(env: Record<string, string>) {
  for (const key of ENV_KEYS) delete process.env[key];
  // 默认不落盘：否则用例之间会共用 .runtime 里的缓存文件，
  // 表现为「明明没打上游却拿到了分」，而且是跨次运行累积的
  Object.assign(process.env, { RATING_PERSIST: '0' }, env);
  vi.resetModules();
  const http = await import('./http');
  http.__setFetcher(makeFetcher());
  const mod = await import('./index');
  return mod;
}

/** 豆瓣 /rexxar 的响应结构：items[].target */
function doubanBody(targets: Array<Record<string, unknown>>) {
  return { items: targets.map((target) => ({ target })) };
}

function doubanSubject(title: string, year: string, score: number, votes: number, kind: 'movie' | 'tv') {
  return {
    id: String(Math.abs(hash(title + year))),
    title,
    year,
    rating: { value: score, count: votes },
    uri: `douban://douban.com/${kind}/${Math.abs(hash(title + year))}`,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function tmdbBody(results: Array<Record<string, unknown>>) {
  return { results };
}

beforeEach(() => {
  calls = [];
  handler = () => ({ status: 200, body: { items: [] } });
});

describe('resolveRating', () => {
  it('豆瓣命中：返回评分、来源与评分人数', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('周处除三害', '2023', 8.1, 1210072, 'movie')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    const result = await mod.resolveRating({ title: '周处除三害', year: '2023' });
    expect(result).toMatchObject({ provider: 'douban', score: 8.1, votes: 1210072, title: '周处除三害' });
    expect(calls).toHaveLength(1);
  });

  it('脏标题先清洗再问上游（源站标题带清晰度标签）', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('周处除三害', '2023', 8.1, 1210072, 'movie')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    await mod.resolveRating({ title: '周处除三害 HD国语', year: '2023' });
    // 上游收到的必须是干净标题，否则脏标题搜不到任何东西
    expect(calls[0]).toContain(encodeURIComponent('周处除三害'));
    expect(calls[0]).not.toContain('HD');
  });

  it('同一条第二次走缓存，不再打上游', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('漫长的季节', '2023', 9.4, 1203922, 'tv')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    const first = await mod.resolveRating({ title: '漫长的季节', year: '2023' });
    const second = await mod.resolveRating({ title: '漫长的季节', year: '2023' });
    expect(first?.score).toBe(9.4);
    expect(second?.score).toBe(9.4);
    expect(calls).toHaveLength(1);
  });

  it('豆瓣未开分（score=0）返回 null，宁缺毋滥', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('仿生迷踪', '2026', 0, 0, 'tv')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    expect(await mod.resolveRating({ title: '仿生迷踪', year: '2026' })).toBeNull();
  });

  it('季数对不上就不给分（不会把第二季的分贴到第三季）', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('破事精英 第二季', '2023', 8.6, 51092, 'tv')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    expect(await mod.resolveRating({ title: '破事精英 3', year: '2024' })).toBeNull();
  });

  it('403 后进入冷却：后续请求直接返回 null 且不再打上游', async () => {
    handler = () => ({ status: 403, body: {} });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    expect(await mod.resolveRating({ title: 'A', year: '2020' })).toBeNull();
    expect(await mod.resolveRating({ title: 'B', year: '2020' })).toBeNull();
    // 第二次被冷却挡住，没有真的发请求
    expect(calls).toHaveLength(1);
    expect(mod.ratingStatus().cooling.douban).toBe(true);
  });

  it('冷却期间不写负缓存（否则冷却结束后会一直以为这片没分）', async () => {
    let blocked = true;
    handler = () => {
      if (blocked) return { status: 403, body: {} };
      return { status: 200, body: doubanBody([doubanSubject('C', '2020', 7.7, 100, 'movie')]) };
    };
    const mod = await setup({ RATING_PROVIDER: 'douban' });
    expect(await mod.resolveRating({ title: 'C', year: '2020' })).toBeNull();

    // 冷却结束后同一条要能重新查到
    blocked = false;
    mod.__testing.throttles.douban.clearPenalty();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const retry = await mod.resolveRating({ title: 'C', year: '2020' });
    vi.useRealTimers();
    expect(retry?.score).toBe(7.7);
  });

  it('RATING_PROVIDER=none 时完全不发请求', async () => {
    const mod = await setup({ RATING_PROVIDER: 'none' });
    expect(await mod.resolveRating({ title: 'X', year: '2020' })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(mod.ratingStatus().enabled).toBe(false);
  });

  it('auto 且配了 TMDB key 时优先走 TMDB，不碰豆瓣', async () => {
    handler = () => ({ status: 200, body: tmdbBody([{ id: 1, media_type: 'movie', title: '肖申克的救赎', release_date: '1994-09-10', vote_average: 8.7, vote_count: 29000 }]) });
    const mod = await setup({ RATING_PROVIDER: 'auto', TMDB_API_KEY: 'test-key' });

    const result = await mod.resolveRating({ title: '肖申克的救赎', year: '1994' });
    expect(result).toMatchObject({ provider: 'tmdb', score: 8.7, votes: 29000 });
    expect(calls[0]).toContain('api.tmdb.org');
  });

  it('TMDB 请求会带上 api_key 与中文语言', async () => {
    handler = () => ({ status: 200, body: tmdbBody([]) });
    const mod = await setup({ RATING_PROVIDER: 'tmdb', TMDB_API_KEY: 'k-123' });

    await mod.resolveRating({ title: '测试', year: '2020' });
    expect(calls[0]).toContain('api_key=k-123');
    expect(calls[0]).toContain('language=zh-CN');
    // api_key 属于凭据，不应出现在别处
    expect(calls[0]).toContain('https://api.tmdb.org/3/search/multi');
  });

  it('TMDB 401 视为被拒（多半是 key 无效），触发冷却', async () => {
    handler = () => ({ status: 401, body: {} });
    const mod = await setup({ RATING_PROVIDER: 'tmdb', TMDB_API_KEY: 'bad' });

    expect(await mod.resolveRating({ title: 'X', year: '2020' })).toBeNull();
    expect(mod.ratingStatus().cooling.tmdb).toBe(true);
  });

  it('豆瓣可通过 RATING_DOUBAN=0 单独关掉', async () => {
    const mod = await setup({ RATING_PROVIDER: 'douban', RATING_DOUBAN: '0' });
    expect(await mod.resolveRating({ title: 'X', year: '2020' })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('resolveRatings', () => {
  it('同名同年只问一次，结果按入参顺序返回', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('我的阿勒泰', '2024', 8.9, 388156, 'tv')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    const results = await mod.resolveRatings([
      { title: '我的阿勒泰', year: '2024' },
      { title: '我的阿勒泰', year: '2024' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBe(8.9);
    expect(results[1]?.score).toBe(8.9);
    expect(calls).toHaveLength(1);
  });

  it('并发问同一条时只发出一个上游请求', async () => {
    handler = () => ({ status: 200, body: doubanBody([doubanSubject('X', '2020', 7.5, 10, 'movie')]) });
    const mod = await setup({ RATING_PROVIDER: 'douban' });

    const [a, b] = await Promise.all([
      mod.resolveRating({ title: 'X', year: '2020' }),
      mod.resolveRating({ title: 'X', year: '2020' }),
    ]);
    expect(a?.score).toBe(7.5);
    expect(b?.score).toBe(7.5);
    expect(calls).toHaveLength(1);
  });

  it('空标题直接返回 null，不浪费请求', async () => {
    const mod = await setup({ RATING_PROVIDER: 'douban' });
    const results = await mod.resolveRatings([{ title: '' }, { title: '   ' }]);
    expect(results).toEqual([null, null]);
    expect(calls).toHaveLength(0);
  });
});

describe('inferKind', () => {
  it('从源站分类名推断电影/剧集', async () => {
    const mod = await setup({ RATING_PROVIDER: 'none' });
    expect(mod.inferKind('动作片')).toBe('movie');
    expect(mod.inferKind('国产剧')).toBe('tv');
    expect(mod.inferKind('国产动漫')).toBe('tv');
    expect(mod.inferKind('综艺')).toBe('tv');
    expect(mod.inferKind('')).toBeUndefined();
    expect(mod.inferKind(undefined)).toBeUndefined();
  });
});
