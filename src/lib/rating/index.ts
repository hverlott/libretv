import { pickBest, cleanTitle, compareKey, normalizeYear, type MediaKind } from './match';
import { RatingCache } from './cache';
import { Throttle } from './throttle';
import { DoubanProvider } from './providers/douban';
import { TmdbProvider } from './providers/tmdb';
import { ProviderRejected, type RatingProvider } from './provider';
import type { RatingProviderId, RatingQuery, RatingResult } from './types';

/**
 * 评分补全编排层。
 *
 * ## 分层
 *
 *   采集站条目（标题脏、多数无评分）
 *        ↓ 标题清洗 + 季/年/类型 匹配（match.ts，纯函数）
 *   provider（TMDB 官方 API / 豆瓣移动端接口）
 *        ↓ 限流（throttle.ts）+ 缓存（cache.ts，落盘键为 HMAC）
 *   评分结果
 *
 * ## 关键取舍
 *
 * - **匹配宁缺毋滥**：季数冲突、年份相距过远直接降到阈值以下。
 *   不给分是无害的，给错分是有害的。
 * - **缓存优先于实时**：评分变化以月计，缓存 30 天。落盘后重启不丢，
 *   对豆瓣这种一撞就封 IP 的源，缓存才是能长期用的根本。
 * - **冷却快速失败**：被封期间直接返回 null，不让前端干等 30 秒。
 */

export type { RatingProviderId, RatingQuery, RatingResult } from './types';
export type { MediaKind } from './match';

/** 单次批量上限：列表一屏 12 条 + 少量余量，防止前端把整页 40 条一次性打过来 */
export const MAX_BATCH = 24;

/** 「确认这片没有可用评分」的缓存时长：短得多，避免把「未开分」当成永久事实 */
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

const tmdbProvider = new TmdbProvider();
const doubanProvider = new DoubanProvider();

const throttles: Record<RatingProviderId, Throttle> = {
  tmdb: new Throttle({ concurrency: 4, minIntervalMs: 0, maxPerWindow: 120, windowMs: 60_000 }),
  // 豆瓣反爬严厉：并发 2、最小间隔 500ms、50 次/分钟，被拒后再由 Throttle 指数退避
  douban: new Throttle({ concurrency: 2, minIntervalMs: 500, maxPerWindow: 50, windowMs: 60_000 }),
};

const cache = new RatingCache({
  ttlMs: (() => {
    const days = parseInt(process.env.RATING_TTL_DAYS || '30', 10);
    return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  })(),
  persist: (process.env.RATING_PERSIST || '1').trim() !== '0',
});

/** 同一键的在途请求：并发问同一个片时只打一次上游 */
const inflight = new Map<string, Promise<RatingResult | null>>();

function cacheKeyOf(query: RatingQuery): string {
  const key = compareKey(query.title);
  const year = normalizeYear(query.year);
  return `${key}|${year ?? ''}`;
}

/** 条目类型：源站分类名 → movie / tv */
export function inferKind(typeName: string | undefined): MediaKind | undefined {
  const text = (typeName || '').trim();
  if (!text) return undefined;
  if (/电影|片/.test(text) && !/连续剧|剧集/.test(text)) return 'movie';
  if (/剧|动漫|动画|综艺|纪录片/.test(text)) return 'tv';
  return undefined;
}

function providerOrder(): RatingProviderId[] {
  const raw = (process.env.RATING_PROVIDER || 'auto').trim().toLowerCase();
  if (raw === 'none' || raw === 'off' || raw === '0') return [];
  if (raw === 'tmdb') return ['tmdb'];
  if (raw === 'douban') return ['douban'];
  // auto：有 TMDB key 就用 TMDB（速率高、中文数据官方），否则退回豆瓣
  return tmdbProvider.available() ? ['tmdb', 'douban'] : ['douban'];
}

function providerOf(id: RatingProviderId): RatingProvider {
  return id === 'tmdb' ? tmdbProvider : doubanProvider;
}

/** 单条查询的结果 + 是否真的问过上游（冷却中不算） */
interface ProviderAttempt {
  result: RatingResult | null;
  attempted: boolean;
}

/** 单个 provider 上一次查询：被拒即冷却，冷却期直接跳过 */
async function queryProvider(id: RatingProviderId, query: RatingQuery): Promise<ProviderAttempt> {
  const throttle = throttles[id];
  if (throttle.coolingDown) return { result: null, attempted: false };

  const provider = providerOf(id);
  if (!provider.available()) return { result: null, attempted: false };

  let candidates;
  try {
    candidates = await throttle.schedule(() => provider.search(query));
    throttle.clearPenalty();
  } catch (err) {
    if (err instanceof ProviderRejected) {
      throttle.penalize();
      return { result: null, attempted: false };
    }
    // 网络错误不惩罚：可能是本机网络抖动，不是被封
    return { result: null, attempted: true };
  }

  const best = pickBest(query, candidates);
  if (!best) return { result: null, attempted: true };

  const year = normalizeYear(best.candidate.year ? String(best.candidate.year) : undefined);
  return {
    result: {
      provider: id,
      score: Math.round(best.candidate.score * 10) / 10,
      votes: best.candidate.votes && best.candidate.votes > 0 ? best.candidate.votes : undefined,
      title: String(best.candidate.title ?? query.title),
      year: year !== undefined ? String(year) : undefined,
      id: best.candidate.externalId,
      kind: best.candidate.kind,
      confidence: Math.round(best.score * 100) / 100,
    },
    attempted: true,
  };
}

/** 查一条评分；缓存命中直接返回，冷却中返回 null */
export async function resolveRating(query: RatingQuery): Promise<RatingResult | null> {
  const title = (query.title || '').trim();
  if (!title) return null;
  // 拿去问上游的是清洗后的标题：脏标题（「周处除三害 HD国语」）在评分站里搜不到任何东西。
  // 清洗只去掉清晰度/语言/进度这类噪声，季数保留（它是区分作品的关键）。
  const searchTitle = cleanTitle(title) || title;

  const key = cacheKeyOf({ ...query, title });
  const cached = cache.get(key);
  if (cached) {
    if (!cached.provider) return null;
    return {
      provider: cached.provider,
      score: cached.score,
      votes: cached.votes || undefined,
      title,
      year: query.year,
      confidence: 1,
    };
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const order = providerOrder();
    if (order.length === 0) return null;
    let probed = false;
    for (const id of order) {
      const { result, attempted } = await queryProvider(id, { ...query, title: searchTitle });
      probed = probed || attempted;
      if (result) {
        cache.set(key, { provider: id, score: result.score, votes: result.votes ?? 0 });
        return result;
      }
    }
    // 只有真的问过上游才写负缓存：被限流挡住时不能假装「这片没分」，
    // 否则冷却结束后 6 小时内都不会再查，等于把限流的后果固化下来
    if (probed) cache.set(key, { provider: null, score: 0, votes: 0 }, NEGATIVE_TTL_MS);
    return null;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/** 批量查评分：去重后并发，返回与入参等长的结果数组 */
export async function resolveRatings(queries: RatingQuery[]): Promise<Array<RatingResult | null>> {
  const keys = queries.map((q) => cacheKeyOf(q));
  const unique = new Map<string, Promise<RatingResult | null>>();
  for (let i = 0; i < queries.length; i++) {
    const key = keys[i];
    if (!unique.has(key)) unique.set(key, resolveRating(queries[i]));
  }
  const awaited = await Promise.all(keys.map((key) => unique.get(key)!));
  return awaited;
}

/** 运行期状态：给 /system 与 /api/privacy/status 展示 */
export function ratingStatus() {
  const order = providerOrder();
  const cacheTtlDays = parseInt(process.env.RATING_TTL_DAYS || '30', 10);
  return {
    enabled: order.length > 0,
    providers: order,
    tmdbConfigured: tmdbProvider.available(),
    doubanEnabled: doubanProvider.available(),
    cacheSize: cache.size,
    cacheTtlDays: Number.isFinite(cacheTtlDays) ? cacheTtlDays : 30,
    cooling: {
      tmdb: throttles.tmdb.coolingDown,
      douban: throttles.douban.coolingDown,
    },
    cooldownRemainingMs: {
      tmdb: throttles.tmdb.cooldownRemainingMs,
      douban: throttles.douban.cooldownRemainingMs,
    },
    pending: {
      tmdb: throttles.tmdb.pending,
      douban: throttles.douban.pending,
    },
  };
}

/** 测试与维护用 */
export const __testing = {
  cache,
  throttles,
  cacheKeyOf,
  flush: () => cache.flush(),
};
