import { requestUpstream } from '../http';
import type { MatchCandidate, MediaKind } from '../match';
import { ProviderRejected, type RatingProvider } from '../provider';
import type { RatingQuery } from '../types';

/**
 * 豆瓣评分提供方（移动端 rexxar 接口，免 key）。
 *
 * ## 为什么是 m.douban.com/rexxar 而不是 movie.douban.com/j/subject_suggest
 *
 * - `j/subject_suggest` 只返回 id/标题/年份，**不带评分**，还要再打一次
 *   `j/subject_abstract` 才能拿到分，一次匹配两个请求；
 * - `rexxar/api/v2/search/movie?q=` 一次就把候选的标题、年份、评分、评分人数全带回来，
 *   **一个请求完成匹配**，对限流紧张的豆瓣来说是决定性的；
 * - 两者都需要 UA + Referer 伪装，缺 Referer 直接 403。
 *
 * ## 限流现实
 *
 * 实测以 150ms 间隔连打 20 次即被封 IP，冷却由编排层的 Throttle 负责（默认并发 1、
 * 最小间隔 900ms、30 次/分钟），被拒后指数退避最长 10 分钟。
 */

const SEARCH_URL = 'https://m.douban.com/rexxar/api/v2/search/movie';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const REFERER = 'https://m.douban.com/movie/subject/1292052/';

interface DoubanTarget {
  id?: string | number;
  title?: string;
  year?: string | number;
  rating?: { value?: number; count?: number };
  uri?: string;
}

interface DoubanResponse {
  items?: Array<{ target?: DoubanTarget } | DoubanTarget>;
}

/** uri 形如 douban://douban.com/tv/35588177，据此区分电影与剧集 */
function kindOf(uri: string | undefined): MediaKind | undefined {
  if (!uri) return undefined;
  if (uri.includes('/tv/')) return 'tv';
  if (uri.includes('/movie/')) return 'movie';
  return undefined;
}

export class DoubanProvider implements RatingProvider {
  readonly id = 'douban' as const;

  available(): boolean {
    return enabled();
  }

  subjectUrl(id: string): string | undefined {
    return `https://movie.douban.com/subject/${id}/`;
  }

  async search(query: RatingQuery): Promise<MatchCandidate[]> {
    const params = new URLSearchParams({ q: query.title, count: '6' });
    const res = await requestUpstream(`${SEARCH_URL}?${params.toString()}`, {
      timeoutMs: 10_000,
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new ProviderRejected(res.status, 'douban');
    }
    if (!res.ok) return [];

    const data = (await res.json()) as DoubanResponse;
    const candidates: MatchCandidate[] = [];
    for (const item of data.items ?? []) {
      const target = (item as { target?: DoubanTarget }).target ?? (item as DoubanTarget);
      if (!target?.title) continue;
      candidates.push({
        title: target.title,
        year: target.year !== undefined ? String(target.year) : undefined,
        score: Number(target.rating?.value ?? 0),
        votes: Number(target.rating?.count ?? 0),
        kind: kindOf(target.uri),
        externalId: target.id !== undefined ? String(target.id) : undefined,
      });
    }
    return candidates;
  }
}

/** 豆瓣可通过 RATING_PROVIDER=none 或 RATING_DOUBAN=0 单独关掉 */
function enabled(): boolean {
  const flag = (process.env.RATING_DOUBAN || '1').trim();
  return flag !== '0' && flag.toLowerCase() !== 'false';
}
