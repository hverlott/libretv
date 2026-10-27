/**
 * 漫画源的元数据与 id 解析。
 *
 * 单独一个文件（与 `mangadex-tags.ts` / `zaimanhua-tags.ts` 同一套路）是为了让
 * **客户端组件也能导入** —— `manga-sources.ts` 依赖两个源的客户端模块，
 * 那里有 `fetchUpstream` 等服务端代码，进不了浏览器 bundle。
 *
 * 这里只放常量与纯函数，不 import 任何网络相关模块。
 */

export type MangaSourceId = 'mangadex' | 'zaimanhua';

export interface MangaSourceMeta {
  id: MangaSourceId;
  /** 切换器上显示的名字 */
  label: string;
  /** 一句话说明，帮用户判断该用哪个 */
  hint: string;
}

/**
 * 源列表，顺序即 UI 上的顺序。
 *
 * 默认源是**再漫画**：它是中文源（约 2 万部，含国漫与汉化），对中文用户更有用；
 * MangaDex 中文译本只有 642 部（英文 4.9 万），留着做国际内容补充。
 */
export const MANGA_SOURCES: MangaSourceMeta[] = [
  { id: 'zaimanhua', label: '再漫画', hint: '中文 · 约 2 万部，含国漫与汉化' },
  { id: 'mangadex', label: 'MangaDex', hint: '国际社区 · 英文为主，中文较少' },
];

export const DEFAULT_MANGA_SOURCE: MangaSourceId = 'zaimanhua';

const SOURCE_IDS: ReadonlySet<string> = new Set(MANGA_SOURCES.map((s) => s.id));

/** 解析 source 参数；未知值回落默认源 */
export function resolveMangaSource(value: string | null | undefined): MangaSourceId {
  const v = (value || '').trim().toLowerCase();
  return SOURCE_IDS.has(v) ? (v as MangaSourceId) : DEFAULT_MANGA_SOURCE;
}
