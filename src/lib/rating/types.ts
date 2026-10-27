import type { MediaKind } from './match';

export type { MediaKind };

/** 评分提供方标识 */
export type RatingProviderId = 'tmdb' | 'douban';

/** 一次评分查询：标题必填，年份与类型用于排除同名作品 */
export interface RatingQuery {
  title: string;
  year?: string;
  kind?: MediaKind;
}

/** 匹配到的评分结果 */
export interface RatingResult {
  provider: RatingProviderId;
  /** 0–10 分制 */
  score: number;
  /** 评分人数 */
  votes?: number;
  /** 评分站侧标题（可能与源标题不同，用于展示来源） */
  title: string;
  year?: string;
  /** 评分站侧条目 id，可拼出详情页链接 */
  id?: string;
  kind?: MediaKind;
  /** 匹配置信度 0–1 */
  confidence: number;
}

/** 缓存条目：命中与「确认未开分/未匹配」都进缓存，避免重复打上游 */
export interface RatingCacheEntry {
  /** 命中结果；null 表示这条查过但没有可用评分 */
  result: RatingResult | null;
  /** 写入时间（毫秒） */
  at: number;
}
