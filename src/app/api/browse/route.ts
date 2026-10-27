import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import {
  aggregateBrowseItems,
  buildTopCategoryMap,
  type RawClassItem,
  type RawListItem,
} from '@/lib/browse-parser';
import { cmsRequestHeaders } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache, clearCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { BrowseCategory, BrowseRegion, BrowseResponse, SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 热门剧集列表：跨源聚合采集站的最新条目并按热度排序。
 *
 * 采集站没有「热门榜」接口（实测 type / orderby 参数被源忽略），
 * 因此这里的做法是：并行拉取各源的列表接口（默认按更新时间倒序），
 * 再用多个信号合成热度排序——
 *   1. 收录源数量（主信号：全网 15 个源都有的剧才是真热门）
 *   2. 源站播放量 vod_hits
 *   3. 豆瓣评分 vod_douban_score（部分源提供，跨源一致更可信）
 *   4. 源站评分 vod_score
 */

/**
 * 首屏每个源抓取的页数。
 *
 * 源站的列表按「更新时间倒序」排列，而采集站的更新以剧集/综艺/动漫为主，
 * 电影等更新量少的分类被挤到很靠后的位置——实测前 3 页几乎取不到电影，
 * 翻到 20 页电影占比才从 7 条升到 153 条（10 源样本）。
 *
 * 但深翻页代价很高：每页 1-2.5 秒，31 源 × 12 页串行约 474 秒。
 * 因此改成「首屏浅取 + 后台递进深翻」：
 * 首屏每源只抓 3 页（覆盖最新更新的剧集/综艺，这是用户最常看的），
 * 随后后台按 3 → 12 → 30 页逐批加深，每批完成就更新缓存，用户无需等待。
 */
const FIRST_SCREEN_PAGES = 3;
/** 同一源内翻页的并发数 */
const PAGE_CONCURRENCY = 6;
/** 缓存时长：热门榜变化不频繁，10 分钟足够 */
const CACHE_TTL = 10 * 60 * 1000;
/** 原始列表数据的缓存时长：比聚合结果略长，切换分类时直接复用，省掉重复爬源 */
const RAW_CACHE_TTL = 20 * 60 * 1000;
/** 单源总死线：慢源不拖垮整体 */
const SOURCE_DEADLINE_MS = 20_000;
/** 同时处理的源数：全部源一起并发会瞬间打出上百个连接，源站容易限流 */
const SOURCE_CONCURRENCY = 8;

/**
 * 固定并发地映射（保持结果顺序）。
 * 直接 Promise.all 全并发会让 23 个源同时各发 6 个请求，
 * 对源站是很大的瞬时压力，也容易触发对方的连接数限制。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 时间窗常量已移除：实测各源忽略 h 参数（加与不加返回同一批数据） */

interface BrowseBody {
  sources: SourceConfig[];
  category?: BrowseCategory;
  region?: BrowseRegion;
  limit?: number;
  filterAdult?: boolean;
}

/** 原始列表数据缓存（与分类无关，切换分类时复用） */
interface RawCache {
  results: SourceListResult[];
  failures: { sourceKey: string; error: string }[];
  sourceCount: number;
}

interface SourceListResult {
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  items: RawListItem[];
  /** 一级分类 id → 名称 */
  topCategories: Map<string, string>;
  error?: string;
}

/**
 * 拉取单个源的列表条目（多页并行）+ 分类表。
 *
 * fromPage/toPage 支持只取某一段页——后台预热用它取更深的页，
 * 避免与首屏重复请求。
 */
async function fetchSourceList(
  source: SourceConfig,
  fromPage = 1,
  toPage = FIRST_SCREEN_PAGES
): Promise<SourceListResult> {
  const base = source.url.replace(/\/+$/, '');
  const verdict = await checkUpstreamAllowed(base);
  if (!verdict.ok) {
    return {
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: base,
      items: [],
      topCategories: new Map(),
      error: verdict.reason,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('源列表超时', 'TimeoutError')),
    SOURCE_DEADLINE_MS
  );

  const fetchPage = async (pg: number): Promise<RawListItem[]> => {
    // 不带 h 参数：实测各源忽略 h（加与不加返回同一批数据），带上只会误导
    const url = `${base}?ac=videolist&pg=${pg}`;
    const res = await fetchUpstream(url, {
      timeoutMs: 8000,
      headers: cmsRequestHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { list?: unknown };
    const list = data.list;
    // 源站无结果时返回 list: null，视为空列表而非格式错误
    if (!Array.isArray(list)) return [];
    return list as RawListItem[];
  };

  /** 分类表：用于把 type_id_1 翻译成一级分类名（电影/连续剧/综艺/动漫…） */
  const fetchCategories = async (): Promise<Map<string, string>> => {
    try {
      const res = await fetchUpstream(`${base}?ac=list`, {
        timeoutMs: 8000,
        headers: cmsRequestHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) return new Map();
      const data = (await res.json()) as { class?: unknown };
      if (!Array.isArray(data.class)) return new Map();
      return buildTopCategoryMap(data.class as RawClassItem[]);
    } catch {
      return new Map();
    }
  };

  try {
    const [pages, topCategories] = await Promise.all([
      // 分批并发：一次 PAGE_CONCURRENCY 个请求，避免单源瞬时打出十几个连接被限流
      (async () => {
        const all: RawListItem[] = [];
        const total = toPage - fromPage + 1;
        const batchCount = Math.ceil(total / PAGE_CONCURRENCY);
        for (let b = 0; b < batchCount; b++) {
          const start = fromPage + b * PAGE_CONCURRENCY;
          const end = Math.min(start + PAGE_CONCURRENCY - 1, toPage);
          if (start > end) break;
          const batch = await Promise.all(
            Array.from({ length: end - start + 1 }, (_, i) => start + i).map((pg) =>
              fetchPage(pg).catch(() => [] as RawListItem[])
            )
          );
          all.push(...batch.flat());
        }
        return all;
      })(),
      fetchCategories(),
    ]);
    return {
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: base,
      items: pages,
      topCategories,
    };
  } catch (err) {
    return {
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: base,
      items: [],
      topCategories: new Map(),
      error: err instanceof Error ? err.message : '请求失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 分类计数（用于前端分类 tab 显示数量） */
function countByCategory(items: { category: BrowseCategory }[]): Record<BrowseCategory, number> {
  const counts: Record<BrowseCategory, number> = {
    all: items.length,
    movie: 0,
    tv: 0,
    anime: 0,
    variety: 0,
    doc: 0,
    short: 0,
    sports: 0,
    adult: 0,
    other: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return counts;
}

/** 地区计数（用于前端地区筛选显示数量） */
function countByRegion(items: { region: BrowseRegion }[]): Record<BrowseRegion, number> {
  const counts: Record<BrowseRegion, number> = {
    all: items.length,
    cn: 0,
    us: 0,
    uk: 0,
    jp: 0,
    kr: 0,
    tw: 0,
    hk: 0,
    th: 0,
    other: 0,
  };
  for (const item of items) counts[item.region] += 1;
  return counts;
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: BrowseBody;
  try {
    body = (await req.json()) as BrowseBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }
  const sources = body.sources.slice(0, 50);
  const category = body.category ?? 'all';
  const region = body.region ?? 'all';
  const limit = Math.min(Math.max(body.limit ?? 120, 1), 300);
  const filterAdult = body.filterAdult !== false;

  // 聚合结果缓存：源集合 + 分类 + 地区 + 成人过滤
  const cacheKey = `browse:${category}:${region}:${filterAdult ? 1 : 0}:${limit}:${sources
    .map((s) => s.url.replace(/\/+$/, ''))
    .sort()
    .join('|')}`;
  const cached = getCache<BrowseResponse>(cacheKey);
  if (cached) return NextResponse.json(cached);

  // 原始列表缓存：只与源集合有关，与分类无关。
  // 切换分类 tab 时直接复用，避免每个分类都重爬一遍源（翻页代价很高）。
  const rawKey = `browse-raw:${sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|')}`;
  let raw = getCache<RawCache>(rawKey);

  if (!raw) {
    // 首屏只浅取（每源 3 页），把响应时间压到秒级；
    // 更深的页由后台递进补齐，用户无需等待。
    const results = await mapWithConcurrency(sources, SOURCE_CONCURRENCY, (s) =>
      fetchSourceList(s, 1, FIRST_SCREEN_PAGES)
    );
    const okResults = results.filter((r) => !r.error && r.items.length > 0);
    const failures = results
      .filter((r) => r.error)
      .map((r) => ({ sourceKey: r.sourceKey, error: r.error as string }));
    raw = { results: okResults, failures, sourceCount: okResults.length };
    setCache(rawKey, raw, RAW_CACHE_TTL);
  }
  const { results: okResults, failures, sourceCount } = raw;

  if (okResults.length === 0) {
    return NextResponse.json(
      { error: failures.length > 0 ? failures[0].error : '没有可用的源' },
      { status: 502 }
    );
  }

  // 先按全部分类聚合，算出各分类条目数（tab 上的数量）
  const all = aggregateBrowseItems(okResults, { limit: 5000, category: 'all', filterAdult });
  const categoryCounts = countByCategory(all.list);
  // 地区计数同样基于全量聚合——否则「选了剧集分类后地区只剩几个」，
  // 用户会以为该地区没内容，实际是被分类过滤掉了
  const regionCounts = countByRegion(all.list);

  // 再按目标分类 + 地区过滤
  const filtered = aggregateBrowseItems(okResults, { limit, category, region, filterAdult });

  const payload: BrowseResponse = {
    list: filtered.list,
    sourceCount,
    categoryCounts,
    regionCounts,
    failures,
    // 后台还在深翻页时如实告知，前端可提示用户稍后刷新看更多
    warming: deepCache.has(rawKey),
  };
  setCache(cacheKey, payload, CACHE_TTL);
  aggregateCacheKeys.add(cacheKey);

  // 后台预热：继续往深处翻页，把电影等「更新量少、位置靠后」的分类补齐。
  // 不阻塞本次响应——用户先看到热门列表，稍后切到电影分类时缓存已就绪。
  if (!deepCache.has(rawKey)) {
    deepCache.add(rawKey);
    void warmDeepPages(rawKey, sources);
  }

  return NextResponse.json(payload);
}

/** 正在预热中的源集合，避免重复触发 */
const deepCache = new Set<string>();

/** 已写入的聚合缓存键（预热补数据后需要按前缀失效） */
const aggregateCacheKeys = new Set<string>();

/**
 * 后台递进深翻的档位。
 *
 * 每档之间让出事件循环，避免长时间占用 CPU；
 * 每档完成后立刻合并进原始缓存并失效聚合缓存——用户下次切分类/刷新
 * 就能看到更全的结果，不必等全部翻完。
 */
const WARM_STAGES = [12, 30];

/**
 * 后台递进深翻页。
 *
 * 从首屏深度之后接着翻（不重复请求首屏已取的页），
 * 逐档加深，每档完成就更新缓存。
 */
async function warmDeepPages(rawKey: string, sources: SourceConfig[]): Promise<void> {
  try {
    let from = FIRST_SCREEN_PAGES + 1;
    for (const to of WARM_STAGES) {
      const extra = await mapWithConcurrency(sources, SOURCE_CONCURRENCY, (s) =>
        fetchSourceList(s, from, to)
      );
      const base = getCache<RawCache>(rawKey);
      if (!base) return;
      // 合并：同源的新页追加到已有条目后面（同一部剧可能在多页重复出现，
      // 聚合层按标题去重，重复无害）
      const bySource = new Map(base.results.map((r) => [r.sourceKey, r]));
      for (const r of extra) {
        const existing = bySource.get(r.sourceKey);
        if (!existing) {
          bySource.set(r.sourceKey, r);
          continue;
        }
        bySource.set(r.sourceKey, {
          ...existing,
          items: [...existing.items, ...r.items],
        });
      }
      setCache(
        rawKey,
        { ...base, results: [...bySource.values()] },
        RAW_CACHE_TTL
      );
      // 原始数据变了，聚合结果缓存需要失效
      invalidateAggregateCaches(sources);
      from = to + 1;
      // 让出事件循环，别把 Next 的请求处理占满
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch {
    // 预热失败不影响主流程
  } finally {
    deepCache.delete(rawKey);
  }
}

/**
 * 原始数据变了，聚合结果缓存需要失效。
 * 预热补进了更深的页，各分类的条目数与排序都会变，
 * 旧的聚合缓存必须丢弃，否则用户切分类看到的还是浅层数据。
 */
function invalidateAggregateCaches(sources: SourceConfig[]): void {
  const suffix = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  for (const key of Array.from(aggregateCacheKeys)) {
    if (key.endsWith(suffix)) {
      aggregateCacheKeys.delete(key);
      clearCache(key);
    }
  }
}
