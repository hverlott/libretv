/**
 * 漫画源注册表与统一分发。
 *
 * 最早漫画板块只有 MangaDex 一个源，所有 API 都是直连 mangadex 的。
 * 接入再漫画（中文源，约 2 万部）后需要一个薄的源分发层：
 *
 * - **显式指定**：请求带 `source=zaimanhua` / `source=mangadex`
 * - **按 id 推断**：只拿到 id 的接口（详情 / 图片）也能判断走哪个源
 *   —— MangaDex 的漫画 id 是 UUID、再漫画是纯数字；
 *     再漫画的章节 id 统一带 `z{漫画id}.{章节id}` 前缀
 *
 * 之所以用「id 推断」而不是全靠参数：阅读器翻页时只有章节 id，
 * 若要求处处透传 source 参数，一旦漏传就会拿 MangaDex 的逻辑去解再漫画的 id。
 */

import {
  browseManga,
  getChapterPages,
  getChapters,
  getMangaDetail,
  pageImageUrl,
  searchManga,
  type MangaBrowseParams,
} from './mangadex';
import {
  browseZaimanhua,
  decodeZaiChapter,
  getZaimanhuaChapterPages,
  getZaimanhuaDetail,
  isZaiComicId,
  searchZaimanhua,
  type ZaiBrowseParams,
} from './zaimanhua';
import type { MangaChapter, MangaItem } from './types';
import { resolveMangaSource, type MangaSourceId } from './manga-source-meta';

// 源元数据本身放在 manga-source-meta.ts（纯常量，客户端可用），这里转出来给路由用
export { resolveMangaSource };
export type { MangaSourceId };

/** MangaDex 的漫画 id 是 UUID */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 按漫画 id 推断源：纯数字是再漫画，UUID 是 MangaDex */
export function detectMangaSource(id: string): MangaSourceId {
  return isZaiComicId(id) ? 'zaimanhua' : 'mangadex';
}

/** 按章节 id 推断源：再漫画的章节 id 带 `z{d}.{d}` 前缀 */
export function detectChapterSource(chapterId: string): MangaSourceId {
  return decodeZaiChapter(chapterId) ? 'zaimanhua' : 'mangadex';
}

/** id 是否是合法的 MangaDex UUID */
export function isMangaDexId(id: string): boolean {
  return UUID_RE.test(id);
}

/* ——————————————— 统一读接口 ——————————————— */

/** 搜索（两个源都是 page-based，内部各自换算） */
export async function searchMangaAny(
  source: MangaSourceId,
  keyword: string,
  opts: {
    page?: number;
    limit?: number;
    includeAdult?: boolean;
    rating?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  if (source === 'zaimanhua') {
    return searchZaimanhua(keyword, { page: opts.page, signal: opts.signal });
  }
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  return searchManga(keyword, {
    limit,
    offset: (page - 1) * limit,
    includeAdult: opts.includeAdult,
    rating: opts.rating,
    signal: opts.signal,
  });
}

/** 分类浏览。再漫画按 theme / zone / cate / status 筛，MangaDex 按标签筛 */
export async function browseMangaAny(
  source: MangaSourceId,
  params: {
    tags?: string[];
    demo?: string | null;
    status?: string | null;
    lang?: string | null;
    origin?: string | null;
    rating?: string | null;
    sort?: string | null;
    page?: number;
    limit?: number;
    includeAdult?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  if (source === 'zaimanhua') {
    const zai: ZaiBrowseParams = {
      // 再漫画的题材是单选，取第一个标签
      theme: params.tags?.[0] ?? null,
      // 地区 / 受众 / 连载状态沿用同一组参数位，取值换成本源的 id
      zone: params.origin ?? null,
      cate: params.demo ?? null,
      status: params.status ?? null,
      sort: params.sort ?? null,
      page: params.page,
    };
    return browseZaimanhua(zai, { signal: params.signal });
  }

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 24));
  const md: MangaBrowseParams = {
    tags: params.tags,
    demographic: params.demo,
    status: params.status,
    language: params.lang,
    origin: params.origin,
    rating: params.rating,
    sort: (params.sort as MangaBrowseParams['sort']) ?? 'latest',
    limit,
    offset: (page - 1) * limit,
    includeAdult: params.includeAdult,
  };
  return browseManga(md, { signal: params.signal });
}

/** 详情 + 章节。source 为空时按 id 推断 */
export async function getMangaDetailAny(
  id: string,
  opts: {
    source?: MangaSourceId | null;
    includeAdult?: boolean;
    rating?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<MangaItem & { chapters: MangaChapter[]; chapterLanguage: string }> {
  const source = opts.source ?? detectMangaSource(id);

  if (source === 'zaimanhua') {
    const { item, chapters } = await getZaimanhuaDetail(id, { signal: opts.signal });
    return {
      ...item,
      chapters,
      chapterLanguage: 'zh',
      chapterCount: chapters.length,
    };
  }

  // 详情与章节必须用同一套分级：限制级作品的 feed 不带对应档位会返回 0 章
  const [detail, chapters] = await Promise.all([
    getMangaDetail(id, {
      includeAdult: opts.includeAdult,
      rating: opts.rating,
      signal: opts.signal,
    }),
    getChapters(id, { includeAdult: opts.includeAdult, rating: opts.rating, signal: opts.signal }),
  ]);
  return {
    ...detail,
    chapters: chapters.chapters,
    chapterLanguage: chapters.language,
    chapterCount: chapters.total,
  };
}

/**
 * 取某章的全部图片地址（上游原始地址，不是代理地址）。
 *
 * 两个源的差异在这里收敛：MangaDex 需要 baseUrl + hash + 文件名拼，
 * 再漫画直接给 URL 列表（带时效签名）。
 */
export async function getChapterImageUrls(
  chapterId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<string[]> {
  const source = detectChapterSource(chapterId);

  if (source === 'zaimanhua') {
    const decoded = decodeZaiChapter(chapterId);
    if (!decoded) throw new Error('再漫画章节 id 非法');
    return getZaimanhuaChapterPages(decoded.comicId, decoded.chapterId, { signal: opts.signal });
  }

  const pages = await getChapterPages(chapterId, { signal: opts.signal });
  return pages.files
    .map((_, i) => pageImageUrl(pages, i))
    .filter((u): u is string => typeof u === 'string');
}
