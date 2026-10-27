/**
 * 内容筛选（成人内容 + 评分门槛）——所有首页内容区共用。
 *
 * ## 为什么抽成独立模块
 *
 * 改造前，各内容区的过滤能力是割裂的：
 * - 搜索结果：过滤成人内容（按分类名）
 * - 热门剧集：过滤成人内容（按分类名 + 片名）
 * - **首页推荐（豆瓣热门 / 豆瓣周榜 / 百度热播剧 / Bangumi）：完全没有过滤**
 *
 * 结果是：用户在设置里打开了「成人内容过滤」，首页推荐区照样冒出成人条目
 * （豆瓣热门里「伦理片」类内容不少，周榜与百度热播剧同理）。
 * 口径不统一还导致「同一��片，在搜索结果里被藏了、在推荐区却露出来」。
 *
 * 本模块把判定收敛到一处：
 * - `ADULT_KEYWORDS` 从 browse-parser 移到此处（词表本身未变，避免行为漂移）；
 * - `isAdultContent()` 供服务端与客户端共同调用；
 * - 评分门槛与「只看有评分」判定也在此实现。
 *
 * ## 评分门槛的语义
 *
 * 不同内容区的评分来源不同，量纲也不同：
 * - 豆瓣推荐 / 豆瓣周榜：豆瓣评分 0–10
 * - 百度热播剧 / Bangumi：**无评分**（恒为 undefined）
 * - 热门剧集：跨源聚合出的豆瓣评分 0–10
 *
 * 因此「只看有评分」= 存在评分且不低于门槛。百度热播剧与 Bangumi 在该模式下
 * 会全部被过滤掉——这是预期行为：它们本就没有评分信息，
 * 开启「只看有评分」意味着「宁缺毋滥，只看有口碑的」。
 */

import { ADULT_KEYWORDS } from './adult-keywords';

/** 评分下限的默认值：豆瓣 6.0 分（低于此基本是烂片） */
export const DEFAULT_MIN_RATING = 6;

/** 内容筛选方式 */
export type ContentFilterMode = 'all' | 'rated';

export interface ContentFilterSettings {
  /** 筛选方式：all = 全选，rated = 只看有评分 */
  mode: ContentFilterMode;
  /** 评分下限（0–10），仅在 mode='rated' 时生效 */
  minRating: number;
}

/** 默认设置：全选 + 6 分门槛 */
export const DEFAULT_CONTENT_FILTER: ContentFilterSettings = {
  mode: 'all',
  minRating: DEFAULT_MIN_RATING,
};

/** 文本是否命中成人关键词 */
export function isAdultText(text: string | undefined | null): boolean {
  if (!text) return false;
  return ADULT_KEYWORDS.some((k) => text.includes(k));
}

/**
 * 成人内容判定（分类名或片名命中成人关键词）。
 *
 * 判定口径与 browse-parser 的分类归并完全一致（共用同一份词表），
 * 避免出现「归类成成人却没被过滤」「被过滤了却归到别的分类」的错位。
 */
export function isAdultContent(entry: {
  typeName?: string | null;
  name?: string | null;
  title?: string | null;
}): boolean {
  if (isAdultText(entry.typeName)) return true;
  // 片名兜底：短剧 / 动漫类里带明显成人关键词的
  return isAdultText(entry.name) || isAdultText(entry.title);
}

/**
 * 解析评分：把可能存在的评分统一成 number，无评分返回 undefined。
 *
 * 豆瓣周榜的 rating 是 number，豆瓣推荐的 rate 是字符串，
 * 百度热播剧与 Bangumi 无评分字段。统一在这里处理，各调用方不必再判断类型。
 */
export function parseRating(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * 按评分门槛筛选。
 *
 * - `mode='all'`：不按评分过滤（全部保留）
 * - `mode='rated'`：只保留有评分且评分 >= 门槛的条目
 *
 * 评分字段有两种命名，这里都认：
 * - `rating`：豆瓣推荐 / 豆瓣周榜（string 或 number）
 * - `doubanScore`：热门剧集（number，来自跨源聚合）
 */
export function filterByRating<T extends { rating?: string | number; doubanScore?: number }>(
  items: T[],
  settings: Pick<ContentFilterSettings, 'mode' | 'minRating'>
): T[] {
  if (settings.mode !== 'rated') return items;
  const threshold = Number.isFinite(settings.minRating) ? settings.minRating : DEFAULT_MIN_RATING;
  return items.filter((item) => {
    const rating = parseRating(item.rating) ?? parseRating(item.doubanScore);
    return rating !== undefined && rating >= threshold;
  });
}

/**
 * 综合筛选：先去掉成人内容，再按评分门槛过滤。
 *
 * 顺序有意为之：成人内容**无条件**去除（不受「全选 / 只看有评分」影响），
 * 评分门槛只影响「非成人内容里保留哪些」。
 * 否则「全选」模式下成人内容会漏出来，隐私保护形同虚设。
 */
export function applyContentFilter<
  T extends { rating?: string | number; doubanScore?: number }
>(items: T[], settings: Pick<ContentFilterSettings, 'mode' | 'minRating'>, isAdult: (item: T) => boolean): T[] {
  const withoutAdult = items.filter((item) => !isAdult(item));
  return filterByRating(withoutAdult, settings);
}
