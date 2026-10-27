import { requestUpstream } from '../http';
import type { MatchCandidate, MediaKind } from '../match';
import { ProviderRejected, ProviderUnavailable, type RatingProvider } from '../provider';
import type { RatingQuery } from '../types';

/**
 * TMDB 评分提供方。
 *
 * ## 为什么基础域名默认是 api.tmdb.org 而不是 api.themoviedb.org
 *
 * 后者在部分网络环境被 DNS 污染（实测本机解析到 208.101.60.87，TCP 直接不通），
 * 而 api.tmdb.org 是同一服务的可用别名。部署者可用 TMDB_API_BASE 覆盖。
 *
 * ## 为什么用 /search/multi
 *
 * 一次请求同时返回电影与剧集，比分别打 /search/movie + /search/tv 省一半请求，
 * 也省去「不知道这是电影还是剧」的猜测。
 */

const DEFAULT_BASE = 'https://api.tmdb.org';
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';

interface TmdbResult {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
}

interface TmdbResponse {
  results?: TmdbResult[];
}

function base(): string {
  const raw = (process.env.TMDB_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : DEFAULT_BASE;
}

function apiKey(): string {
  return (process.env.TMDB_API_KEY || '').trim();
}

function dateYear(...candidates: Array<string | undefined>): number | undefined {
  for (const value of candidates) {
    const m = value?.match(/(19|20)\d{2}/);
    if (m) return parseInt(m[0], 10);
  }
  return undefined;
}

function kindOf(result: TmdbResult): MediaKind | undefined {
  if (result.media_type === 'movie') return 'movie';
  if (result.media_type === 'tv') return 'tv';
  return undefined;
}

export class TmdbProvider implements RatingProvider {
  readonly id = 'tmdb' as const;

  available(): boolean {
    return apiKey().length > 0;
  }

  subjectUrl(id: string): string | undefined {
    return `https://www.themoviedb.org/${id}`;
  }

  async search(query: RatingQuery): Promise<MatchCandidate[]> {
    const key = apiKey();
    if (!key) throw new ProviderUnavailable('未配置 TMDB_API_KEY');

    const params = new URLSearchParams({
      api_key: key,
      language: 'zh-CN',
      query: query.title,
      include_adult: 'false',
      page: '1',
    });
    const res = await requestUpstream(`${base()}/3/search/multi?${params.toString()}`, {
      timeoutMs: 10_000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new ProviderRejected(res.status, 'tmdb');
    }
    if (!res.ok) throw new ProviderUnavailable(`TMDB 响应异常 (${res.status})`);

    const data = (await res.json()) as TmdbResponse;
    const candidates: MatchCandidate[] = [];
    for (const result of data.results ?? []) {
      // 人名条目不参与评分匹配；media_type 缺失时按有无标题字段推断
      if (result.media_type === 'person') continue;
      const kind = kindOf(result) ?? (result.title ? 'movie' : 'tv');
      // /search/multi 不支持 media_type 过滤，查询已知类型时在这里收窄
      if (query.kind && kind !== query.kind) continue;
      const title = result.title || result.name || result.original_title || result.original_name;
      if (!title) continue;
      const year = dateYear(result.release_date, result.first_air_date);
      candidates.push({
        title,
        year: year !== undefined ? String(year) : undefined,
        score: Number(result.vote_average ?? 0),
        votes: Number(result.vote_count ?? 0),
        kind,
        externalId: String(result.id ?? ''),
      });
    }
    return candidates;
  }
}
