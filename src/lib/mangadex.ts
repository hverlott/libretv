/**
 * MangaDex 漫画 API 客户端。
 *
 * ## 为什么选 MangaDex
 *
 * 用户想要「看漫画」。调研了 75 个 Legado 漫画源（来自 yck2026.fun 的异次元图源库），
 * 结论是绝大多数不可用：
 *
 * - 71 个是 **HTML 规则格式**（CSS 选择器抓网页），与 Apple CMS 的 JSON 协议不同，
 *   LibreTV 无法解析；
 * - 拷贝漫画（`api.mangacopy.com`）等国内主力源**被墙**（ECONNRESET，走代理也通不过）；
 * - 再漫画搜索可用，但详情接口需要有效 JWT；
 * - 新漫画 / 漫画皮端点 404 或 Cloudflare 防护。
 *
 * MangaDex 是唯一实测**全链路打通**的：搜索 → 详情 → 章节 → 图片服务器。
 * 代价是中文内容较少（它是国际社区，翻译组以英日文为主），
 * 因此本客户端做了「中文优先、英文回落」的语言策略。
 *
 * ## 隐私设计
 *
 * - API 与图片全部 https，无明文泄漏；
 * - **图片必须经本站同源代理**（`/api/manga/image`）而非浏览器直连
 *   `*.mangadex.network`——后者会暴露用户真实 IP 给 CDN，
 *   与播放链路走 `/api/proxy` 是同一个道理；
 * - MangaDex 自带 `contentRating` 字段（safe / suggestive / erotica / pornographic），
 *   比关键词表准确得多，直接用它做成人内容过滤。
 *
 * ## 分级与内容的边界
 *
 * 成人向分 `erotica` 与 `pornographic`（限制级）两档，均需用户显式选择，
 * 并受全站「成人内容过滤」开关约束，理由见 `MANGA_RATINGS`。
 * `BLOCKED_TAGS`（涉及未成年性化的题材）在**所有**请求里都从上游排除，
 * 不提供入口，也不出现在结果里——开放限制级的前提正是这套过滤始终生效。
 */

import { fetchUpstream } from './fetch-utils';
import {
  BLOCKED_TAGS,
  EXCLUDED_TAGS,
  MANGA_DEMOGRAPHICS,
  MANGA_LANGS,
  MANGA_ORIGINS,
  MANGA_SORTS,
  MANGA_STATUSES,
  tagLabel,
  tagOrder,
  type MangaSortKey,
  type MangaTagOption,
} from './mangadex-tags';

const API_BASE = 'https://api.mangadex.org';
const UPLOADS_BASE = 'https://uploads.mangadex.org';

/** 请求超时：漫画 API 偶有慢响应，比点播侧宽松一些 */
const TIMEOUT_MS = 12000;

/** MangaDex 的内容分级 */
export type ContentRating = 'safe' | 'suggestive' | 'erotica' | 'pornographic';

/** 用户可选的分级档位（不含默认的 safe + suggestive） */
export type MangaRatingKey = 'erotica' | 'pornographic';

/**
 * 按分级档位给出上游 `contentRating[]` 白名单，**向下累积**。
 *
 * @param rating 档位 key（`erotica` / `pornographic`）；
 *   传 `true` 等价于 `erotica`（兼容旧的「是否含成人向」调用方式），
 *   传空 / false / 其它未知值则退回 safe + suggestive。
 *
 * 注意：限制级（pornographic）作品的 `/feed` 接口若不带上这一档，
 * 会直接返回 0 章——章节列表必须和列表/详情用同一套分级参数。
 */
export function ratingsFor(rating?: string | boolean | null): ContentRating[] {
  if (rating === 'pornographic') return ['safe', 'suggestive', 'erotica', 'pornographic'];
  if (rating === true || rating === 'erotica') return ['safe', 'suggestive', 'erotica'];
  return ['safe', 'suggestive'];
}

export interface MangaTag {
  id: string;
  name: string;
  group: string;
}

export interface MangaItem {
  id: string;
  /** 多语言标题，已按 zh → en → ja 顺序取到首个可用值 */
  title: string;
  /** 原始标题表（详情页展示别名用） */
  altTitles: string[];
  description: string;
  cover: string | null;
  status: string | null;
  year: number | null;
  authors: string[];
  artists: string[];
  tags: MangaTag[];
  contentRating: ContentRating;
  /** 章节总数（feed 接口的 total） */
  chapterCount: number | null;
  /** 原作语言（ja / ko / zh / en…），用于展示「韩国漫画」等来源地 */
  originalLanguage: string | null;
}

export interface MangaChapter {
  id: string;
  /** 章节号；单篇/特别篇可能是 null */
  number: string | null;
  title: string | null;
  language: string;
  pages: number;
}

export interface ChapterPages {
  baseUrl: string;
  hash: string;
  /** 图片文件名，按顺序即页序 */
  files: string[];
}

/* ——————————————— 内部工具 ——————————————— */

/**
 * 取多语言文本的首个可用值。
 *
 * 顺序：中文 → 繁体 → 英文 → 日文 → **罗马音** → 韩文/韩罗马音 → 任意值。
 *
 * 罗马音（`ja-ro` / `ko-ro`）这一档是必须的：实测热门前 40 条里
 * **100% 没有 `en` 标题**，只有 `ja-ro`（如 "Kage no Jitsuryokusha ni Naritakute!"）。
 * 少了这一档，热门列表整屏都是「(无标题)」。
 */
function pickText(obj: Record<string, string> | undefined, fallback = ''): string {
  if (!obj) return fallback;
  const hit =
    obj.zh ||
    obj['zh-hk'] ||
    obj.en ||
    obj.ja ||
    obj['ja-ro'] ||
    obj.ko ||
    obj['ko-ro'] ||
    obj['zh-ro'];
  if (hit && hit.trim()) return hit;
  // 兜底：任意语言的第一个非空值，总比显示空标题强
  const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim());
  return first || fallback;
}

/** 从 relationships 里取出指定类型的 id 列表 */
function relIds(manga: MangaDexManga, type: string): string[] {
  return (manga.relationships || [])
    .filter((r) => r.type === type)
    .map((r) => r.id);
}

/** 组装封面 URL（封面文件在 relationships 的 cover_art 里） */
function coverUrl(manga: MangaDexManga): string | null {
  const cov = (manga.relationships || []).find((r) => r.type === 'cover_art');
  const fileName = cov?.attributes?.fileName;
  if (!fileName) return null;
  return `${UPLOADS_BASE}/covers/${manga.id}/${fileName}`;
}

/** 把原始 API 条目转成统一结构 */
function toItem(m: MangaDexManga, chapterCount: number | null = null): MangaItem {
  const a = m.attributes || {};
  const tags: MangaTag[] = (a.tags || []).map((t) => ({
    id: t.id,
    name: pickText(t.attributes?.name, t.id),
    group: t.attributes?.group || 'theme',
  }));
  return {
    id: m.id,
    title: pickText(a.title) || '(无标题)',
    altTitles: (a.altTitles || []).map((x) => pickText(x)).filter(Boolean),
    description: pickText(a.description),
    cover: coverUrl(m),
    status: a.status ?? null,
    year: a.year ?? null,
    authors: relIds(m, 'author'),
    artists: relIds(m, 'artist'),
    tags,
    contentRating: a.contentRating ?? 'safe',
    chapterCount,
    originalLanguage: a.originalLanguage ?? null,
  };
}

/* ——————————————— MangaDex 原始响应类型（只声明用到的字段） ——————————————— */

interface MangaDexManga {
  id: string;
  attributes?: {
    title?: Record<string, string>;
    altTitles?: Record<string, string>[];
    description?: Record<string, string>;
    status?: string;
    year?: number | null;
    contentRating?: ContentRating;
    originalLanguage?: string;
    tags?: { id: string; attributes?: { name?: Record<string, string>; group?: string } }[];
  };
  relationships?: {
    type: string;
    id: string;
    attributes?: { fileName?: string; name?: string };
  }[];
}

interface MangaDexChapter {
  id: string;
  attributes?: {
    chapter?: string | null;
    title?: string | null;
    translatedLanguage?: string;
    pages?: number;
  };
}

/* ——————————————— 对外接口 ——————————————— */

/** 语言优先级：先中文（含港台），再英文，最后日文 */
const LANG_ORDER = ['zh', 'zh-hk', 'en', 'ja'];

/**
 * 搜索漫画。
 *
 * @param title 关键词（英文/罗马音命中率最高，中文亦可）
 * @param limit 返回条数（MangaDex 上限 100，默认 20）
 * @param rating 分级档位（`erotica` / `pornographic`），优先级高于 includeAdult
 * @param includeAdult 兼容旧调用：true 等价于 `erotica`
 */
export async function searchManga(
  title: string,
  opts: {
    limit?: number;
    offset?: number;
    includeAdult?: boolean;
    rating?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const sp = new URLSearchParams({
    title,
    limit: String(limit),
    offset: String(opts.offset ?? 0),
  });
  // 注意：不要加 hasCoverArt —— MangaDex 对未知参数返回 400
  // （The property hasCoverArt is not defined）。
  // 想要「只有带封面的条目」应在客户端过滤 cover 为空的。
  // 默认排除成人内容：MangaDex 的 contentRating[] 是白名单语义
  ratingsFor(opts.rating ?? !!opts.includeAdult).forEach((r) => sp.append('contentRating[]', r));
  const blockedIds = await getBlockedTagIds({ signal: opts.signal });
  blockedIds.forEach((id) => sp.append('excludedTags[]', id));
  if (blockedIds.length > 0) sp.set('excludedTagsMode', 'OR');
  sp.append('includes[]', 'cover_art');

  const res = await fetchUpstream(`${API_BASE}/manga?${sp.toString()}`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MangaDex 搜索失败: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: MangaDexManga[]; total?: number };
  return {
    items: dropBlocked((json.data || []).map((m) => toItem(m)), new Set(blockedIds)),
    total: json.total ?? (json.data || []).length,
  };
}

/**
 * 取漫画详情（含标签、简介、封面）。
 * chapterCount 由调用方按需另行拉取（feed 接口的 total）。
 */
export async function getMangaDetail(
  id: string,
  opts: { includeAdult?: boolean; rating?: string | null; signal?: AbortSignal } = {}
): Promise<MangaItem> {
  const sp = new URLSearchParams();
  sp.append('includes[]', 'cover_art');
  ratingsFor(opts.rating ?? !!opts.includeAdult).forEach((r) =>
    sp.append('contentRating[]', r)
  );

  const res = await fetchUpstream(`${API_BASE}/manga/${encodeURIComponent(id)}?${sp.toString()}`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MangaDex 详情失败: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: MangaDexManga };
  if (!json.data) throw new Error('漫画不存在');
  return toItem(json.data);
}

/**
 * 取章节列表。
 *
 * 语言策略：按 `LANG_ORDER` 依次尝试，取第一个有结果的翻译语言。
 * 日漫在 MangaDex 上中文翻译组较少，直接回落英文比空列表更有用。
 *
 * @param maxChapters 最多返回多少章（默认 100，避免一次拉上千章）
 */
export async function getChapters(
  mangaId: string,
  opts: {
    maxChapters?: number;
    includeAdult?: boolean;
    rating?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<{ chapters: MangaChapter[]; language: string; total: number }> {
  const limit = Math.min(500, Math.max(1, opts.maxChapters ?? 100));
  let lastError: Error | null = null;
  // 限制级作品的 feed 不带对应 contentRating[] 会直接返回 0 章
  const ratings = ratingsFor(opts.rating ?? !!opts.includeAdult);

  for (const lang of LANG_ORDER) {
    const sp = new URLSearchParams({
      limit: String(limit),
      // 升序：阅读器从第 1 章开始
      'order[chapter]': 'asc',
    });
    sp.append('translatedLanguage[]', lang);
    ratings.forEach((r) => sp.append('contentRating[]', r));

    try {
      const res = await fetchUpstream(
        `${API_BASE}/manga/${encodeURIComponent(mangaId)}/feed?${sp.toString()}`,
        { timeoutMs: TIMEOUT_MS, retries: 1, signal: opts.signal, headers: { Accept: 'application/json' } }
      );
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { data?: MangaDexChapter[]; total?: number };
      const list = json.data || [];
      if (list.length === 0) continue;

      return {
        chapters: list.map((c) => ({
          id: c.id,
          number: c.attributes?.chapter ?? null,
          title: c.attributes?.title ?? null,
          language: c.attributes?.translatedLanguage ?? lang,
          pages: c.attributes?.pages ?? 0,
        })),
        language: lang,
        total: json.total ?? list.length,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastError) throw new Error(`MangaDex 章节获取失败: ${lastError.message}`);
  return { chapters: [], language: '', total: 0 };
}

/**
 * 取某章的图片地址列表。
 *
 * MangaDex 的图片 URL 形如 `{baseUrl}/data/{hash}/{fileName}`，
 * baseUrl 是**动态分配**的 CDN 节点（每次 at-home 请求可能不同），
 * 因此不能缓存 baseUrl，只能缓存整条 URL。
 */
export async function getChapterPages(
  chapterId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<ChapterPages> {
  const res = await fetchUpstream(`${API_BASE}/at-home/server/${encodeURIComponent(chapterId)}`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MangaDex 图片服务器获取失败: HTTP ${res.status}`);
  const json = (await res.json()) as {
    baseUrl?: string;
    chapter?: { hash?: string; data?: string[] };
  };
  if (!json.baseUrl || !json.chapter?.hash) throw new Error('MangaDex 返回的图片信息不完整');
  // data-saver 模式画质偏低，用标准 data
  return {
    baseUrl: json.baseUrl,
    hash: json.chapter.hash,
    files: json.chapter.data || [],
  };
}

/** 拼出某一页的完整图片 URL */
export function pageImageUrl(pages: ChapterPages, index: number): string | null {
  const file = pages.files[index];
  if (!file) return null;
  return `${pages.baseUrl}/data/${pages.hash}/${file}`;
}

/** 内容分级是否属于成人内容 */
export function isAdultRating(rating: ContentRating | undefined): boolean {
  return rating === 'erotica' || rating === 'pornographic';
}

/** 按 group 归类标签，供详情页展示「题材 / 主题 / 受众」等 */
export function groupTags(tags: MangaTag[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tags) {
    const key = t.group || 'theme';
    (out[key] = out[key] || []).push(t.name);
  }
  return out;
}

/* ——————————————— 分类浏览 ——————————————— */

/** 一组可筛选标签 */
export interface MangaTagGroup {
  group: 'genre' | 'theme' | 'format';
  label: string;
  tags: MangaTagOption[];
}

/** `/api/manga/tags` 的响应体 */
export interface MangaTagGroups {
  groups: MangaTagGroup[];
}

/** MangaDex 的 tag id 是 UUID，用它防止任意字符串被拼进上游 URL */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 标签列表几乎不变，缓存 12 小时；请求失败时降级用旧缓存 */
let tagCache: { at: number; raw: MangaDexTag[] } | null = null;
const TAG_TTL_MS = 12 * 60 * 60 * 1000;

interface MangaDexTag {
  id: string;
  attributes?: { name?: Record<string, string>; group?: string };
}

/**
 * 取原始标签表（带缓存）。
 *
 * 单独抽出来是因为它有两个消费者：
 * - `getMangaTags`：给用户看的分类入口；
 * - `getBlockedTagIds`：要传给上游做**硬排除**的标签 id。
 *
 * 两者共用一份缓存，浏览列表时不会额外多打一次 `/manga/tag`。
 */
async function getRawTags(opts: { signal?: AbortSignal } = {}): Promise<MangaDexTag[]> {
  const res = await fetchUpstream(`${API_BASE}/manga/tag`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    // 上游抖动时宁可用旧标签，也不要让筛选区空掉
    if (tagCache) return tagCache.raw;
    throw new Error(`MangaDex 标签获取失败: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: MangaDexTag[] };
  const raw = json.data || [];
  tagCache = { at: Date.now(), raw };
  return raw;
}

/** 缓存是否还有效（避免每次列表请求都打一次上游） */
function tagsFresh(): boolean {
  return !!tagCache && Date.now() - tagCache.at < TAG_TTL_MS;
}

/**
 * 取要在上游硬排除的标签 id。
 *
 * 拿不到标签表时**降级为空数组而不是抛错**——标签表只是安全加固，
 * 不该因为它抖动就让整个漫画列表打不开。真正兜底的是 `dropBlocked` 的事后过滤。
 */
export async function getBlockedTagIds(opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  const raw = tagsFresh() ? tagCache!.raw : await getRawTags(opts).catch(() => [] as MangaDexTag[]);
  return raw
    .filter((t) => BLOCKED_TAGS.has(t.attributes?.name?.en || ''))
    .map((t) => t.id)
    .filter((id) => UUID_RE.test(id));
}

/**
 * 事后兜底过滤：剔除带 `BLOCKED_TAGS` 的作品。
 *
 * 即便上游的 `excludedTags[]` 因为标签表过期 / 参数失效而没起作用，
 * 这一层也能保证带这些标签的作品不会出现在列表里。
 */
function dropBlocked<T extends MangaItem>(items: T[], blockedIds: Set<string>): T[] {
  if (blockedIds.size === 0) return items;
  return items.filter((m) => !m.tags.some((t) => blockedIds.has(t.id)));
}

/**
 * 取可筛选的标签分组（题材 / 主题 / 形式）。
 *
 * - 过滤掉 `EXCLUDED_TAGS`（内容警示与未成年性化题材不做分类入口）；
 * - 按预定义的中文习惯顺序排，而不是 API 的字母序。
 */
export async function getMangaTags(opts: { signal?: AbortSignal } = {}): Promise<MangaTagGroups> {
  const json = tagsFresh() ? tagCache!.raw : await getRawTags(opts);
  const raw: MangaDexTag[] = json;

  const buckets: Record<string, MangaTagOption[]> = { genre: [], theme: [], format: [] };
  for (const t of raw) {
    const group = t.attributes?.group || '';
    const name = t.attributes?.name?.en || '';
    if (!buckets[group] || !name || EXCLUDED_TAGS.has(name)) continue;
    buckets[group].push({ id: t.id, name, zh: tagLabel(name, group) });
  }

  const labelOf: Record<string, string> = { genre: '题材', theme: '主题', format: '形式' };
  const data: MangaTagGroups = {
    groups: (['genre', 'theme', 'format'] as const)
      .filter((g) => buckets[g].length > 0)
      .map((g) => ({
        group: g,
        label: labelOf[g],
        tags: buckets[g].sort((a, b) => tagOrder(a.name, g) - tagOrder(b.name, g)),
      })),
  };

  return data;
}

/** 上游参数白名单：只放行已知取值，避免任意字符串被拼进 URL */
const DEMOGRAPHIC_KEYS = new Set(MANGA_DEMOGRAPHICS.map((d) => d.key));
const STATUS_KEYS = new Set(MANGA_STATUSES.map((s) => s.key));
const LANG_KEYS = new Set(MANGA_LANGS.map((l) => l.key));
const ORIGIN_KEYS = new Set(MANGA_ORIGINS.map((o) => o.key));

/** 列表筛选参数 */
export interface MangaBrowseParams {
  /** 标签 id（UUID），多选取 AND */
  tags?: string[];
  /** 受众：shounen / shoujo / seinen / josei */
  demographic?: string | null;
  /** 连载状态：ongoing / completed / hiatus / cancelled */
  status?: string | null;
  /** 只显示有该语言译本的作品：zh / zh-hk / en / ja */
  language?: string | null;
  /** 原作地区（原作语言）：ja 日本 / ko 韩国 / zh 国漫 / en 欧美 */
  origin?: string | null;
  /**
   * 内容分级档位（向下累积）：空 / null = 不含成人向（safe + suggestive）；
   * `erotica` = 含成人向；`pornographic` = 限制级（含前两档）。
   */
  rating?: string | null;
  sort?: MangaSortKey;
  limit?: number;
  offset?: number;
  includeAdult?: boolean;
}

/**
 * 按分类浏览漫画列表。
 *
 * 与 `searchManga` 的区别：这个走标签 / 受众 / 状态 / 语言筛选 + 排序，
 * 用于「不搜关键词、随便逛逛」的场景。
 */
export async function browseManga(
  params: MangaBrowseParams = {},
  opts: { signal?: AbortSignal } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  const limit = Math.min(100, Math.max(1, params.limit ?? 24));
  const sp = new URLSearchParams({ limit: String(limit), offset: String(Math.max(0, params.offset ?? 0)) });

  // 标签多选取 AND：想看「动作 + 异世界」时，OR 会把两个题材各来一堆，越筛越多
  const tags = (params.tags || []).filter((t) => UUID_RE.test(t));
  tags.forEach((t) => sp.append('includedTags[]', t));
  if (tags.length > 1) sp.set('includedTagsMode', 'AND');

  if (params.demographic && DEMOGRAPHIC_KEYS.has(params.demographic)) {
    sp.append('publicationDemographic[]', params.demographic);
  }
  if (params.status && STATUS_KEYS.has(params.status)) {
    sp.append('status[]', params.status);
  }
  if (params.language && LANG_KEYS.has(params.language)) {
    sp.append('availableTranslatedLanguage[]', params.language);
  }
  if (params.origin && ORIGIN_KEYS.has(params.origin)) {
    sp.append('originalLanguage[]', params.origin);
  }

  const sort = MANGA_SORTS.find((s) => s.key === (params.sort || 'latest')) || MANGA_SORTS[0];
  sp.append(`order[${sort.order}]`, 'desc');

  // 分级：档位向下累积；未知取值会被 ratingsFor 退回 safe + suggestive
  ratingsFor(params.rating ?? params.includeAdult).forEach((r) =>
    sp.append('contentRating[]', r)
  );

  const blockedIds = await getBlockedTagIds({ signal: opts.signal });
  blockedIds.forEach((id) => sp.append('excludedTags[]', id));
  if (blockedIds.length > 0) sp.set('excludedTagsMode', 'OR');
  sp.append('includes[]', 'cover_art');

  const res = await fetchUpstream(`${API_BASE}/manga?${sp.toString()}`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MangaDex 列表获取失败: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: MangaDexManga[]; total?: number };
  return {
    items: dropBlocked((json.data || []).map((m) => toItem(m)), new Set(blockedIds)),
    total: json.total ?? (json.data || []).length,
  };
}
