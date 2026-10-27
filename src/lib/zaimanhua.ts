/**
 * 再漫画（zaimanhua）v4 API 客户端。
 *
 * ## 为什么接它
 *
 * LibreTV 的漫画板块原本只有 MangaDex。MangaDex 是国际社区，**中文译本仅 642 部**
 * （英文 4.9 万），中文用户基本找不到能看的。
 *
 * 调研 8 个 TVBox 仓库 + Venera 漫画源仓库（见 `VENERA_COMIC_SOURCES.md`）后，
 * 再漫画是**唯一实测全链路打通且无需登录**的中文源。**总库约 2 万部中文漫画**，
 * 并且 `zone` 参数能按地区筛（内地 / 日本 / 韩国 / 欧美 / 港台），
 * 内容是汉化的 —— 比 MangaDex 那些只有英文译本的韩漫实用得多。
 *
 * | 能力 | 端点 | 状态 |
 * |---|---|---|
 * | 筛选浏览 | `comic/filter/list?theme&zone&cate&status&sortType&page` | ✅ |
 * | 排行榜 | `comic/rank/list?rank_type&by_time&page` | ✅ |
 * | 搜索 | `search/index?keyword=xx&page=n` | ✅ |
 * | 详情 + 章节 | `comic/detail/{comicId}` | ✅ |
 * | 章节图片 | `comic/chapter/{comicId}/{chapterId}` | ✅ |
 *
 * 对比：拷贝漫画已废（接口改版返回 404 HTML）、picacg/漫小肆域名不通、
 * Venera 那 31 个源要么要登录、要么要 HTML 抓取、要么得跑 JS 引擎。
 *
 * ## 两个必须记住的坑
 *
 * **① 列表接口选错了就等于没筛选。** `comic/update/list/{catId}/{page}`
 * 的 catId **上游根本不生效** —— 实测 10 个题材返回的是完全相同的列表。
 * 真正支持筛选的是 `comic/filter/list`。
 *
 * **② 同一份数据在三个接口里字段名不同**，必须都兼容：
 *
 * - 标题：`search` / `update/list` 是 `title`，`filter/list` 是 **`name`**
 * - 题材 `types`、作者 `authors`、状态 `status`：列表接口给逗号字符串，详情给对象数组
 * - 漫画 id：`search` / `update/list` 里 `comic_id` 与 `id` 二选一有值（另一个为 0），
 *   `filter/list` 里直接就是 `id`
 * - 章节图片在 `data.data.page_url`（**双层 data**，少读一层会拿到空数组）
 *
 * ## 隐私
 *
 * 与 MangaDex 侧一致：图片绝不浏览器直连 `images.zaimanhua.com`，
 * 一律经 `/api/manga/image` 同源代理，避免真实 IP 暴露给图床 CDN。
 */

import { mapWithConcurrency } from './concurrent-map';
import { fetchUpstream } from './fetch-utils';
import {
  ZAI_CATES,
  ZAI_CATEGORIES,
  ZAI_STATUSES,
  ZAI_ZONES,
  zaiAllow,
  zaiSortType,
} from './zaimanhua-tags';
import type { MangaChapter, MangaItem, MangaTag, MangaTagOption } from './types';

const API_BASE = 'https://v4api.zaimanhua.com/app/v1';
const TIMEOUT_MS = 12000;

/**
 * 请求头。
 * `Authorization` 未登录时留空即可 —— 实测各端点在空 token 下都正常返回，
 * 只有「每日签到」这类需要登录态的功能才用得上真 token。
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android) Mobile',
  Accept: 'application/json',
  Authorization: 'Bearer ',
};

/** 漫画 id 是纯数字；章节 id 形如 `z{comicId}.{chapterId}` */
const COMIC_ID_RE = /^\d{1,12}$/;
const CHAPTER_KEY_RE = /^z(\d{1,12})\.(\d{1,12})$/;

/** 把「漫画 id + 章节 id」编成一个章节 key，供 /api/manga/pages 与 image 使用 */
export function encodeZaiChapter(comicId: string, chapterId: string): string {
  return `z${comicId}.${chapterId}`;
}

/**
 * 反解章节 key。
 *
 * 用带前缀的格式而不是裸 id，是为了让 `/api/manga/image` 这类只拿到章节 id 的
 * 接口也能判断该走哪个源 —— MangaDex 的章节 id 是 UUID，两者不会混淆。
 */
export function decodeZaiChapter(key: string): { comicId: string; chapterId: string } | null {
  const m = CHAPTER_KEY_RE.exec(key);
  if (!m) return null;
  return { comicId: m[1], chapterId: m[2] };
}

/** 判断一个漫画 id 是否属于再漫画（纯数字） */
export function isZaiComicId(id: string): boolean {
  return COMIC_ID_RE.test(id);
}

/** 上游每页条数（size 参数最大值就是 20） */
export const ZAI_PAGE_SIZE = 20;

/** 题材分类表转成 `/api/manga/tags` 的响应结构，供前端统一消费 */
export function getZaimanhuaCategories(): MangaTagOption[] {
  return ZAI_CATEGORIES.filter((c) => c.key !== '0').map((c) => ({
    id: c.key,
    name: c.key,
    zh: c.label,
  }));
}

/* ——————————————— 字段解析（列表 / 详情两套结构的兼容层） ——————————————— */

/**
 * 中文题材名 → 题材 id。
 *
 * 列表接口只给 `"奇幻,日常"` 这种字符串（没有 id），详情接口才给 `tag_id`。
 * 建立这层映射后，从列表进详情再点标签也能回到正确的分类列表 ——
 * 否则中文名当 id 传上去会被白名单挡掉，等于点了没反应。
 */
const CATEGORY_ID_BY_LABEL: ReadonlyMap<string, string> = new Map(
  ZAI_CATEGORIES.map((c) => [c.label, c.key])
);

/** 标签可能来自列表的逗号字符串，也可能来自详情的对象数组 */
function parseTags(value: unknown): MangaTag[] {
  if (typeof value === 'string') {
    return value
      .split(/[,，/、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ id: CATEGORY_ID_BY_LABEL.get(s) ?? s, name: s, group: 'genre' }));
  }
  if (Array.isArray(value)) {
    return value
      .map((t) => {
        if (typeof t === 'string') {
          return { id: CATEGORY_ID_BY_LABEL.get(t) ?? t, name: t, group: 'genre' };
        }
        const name = (t as { tag_name?: string })?.tag_name;
        const id = (t as { tag_id?: number | string })?.tag_id;
        return name ? { id: String(id ?? name), name, group: 'genre' } : null;
      })
      .filter((t): t is MangaTag => t !== null);
  }
  return [];
}

/** 作者/状态同理：字符串或对象数组 */
function parseNames(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,，/、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((t) => (typeof t === 'string' ? t : (t as { tag_name?: string })?.tag_name))
      .filter((n): n is string => !!n);
  }
  return [];
}

/** 状态：列表给「连载中 / 已完结」字符串，详情给对象数组，统一取第一个文本 */
function parseStatus(value: unknown): string | null {
  return parseNames(value)[0] ?? null;
}

/** 列表条目里的漫画 id：`comic_id` 与 `id` 二选一有值，另一个是 0 */
function pickId(item: { id?: number | string; comic_id?: number | string }): string {
  const hit = [item.comic_id, item.id].find((v) => v && String(v) !== '0');
  return hit ? String(hit) : '';
}

/* ——————————————— 上游响应类型 ——————————————— */

interface ZaiListItem {
  id?: number | string;
  comic_id?: number | string;
  /** filter/list 用 name，search / update/list 用 title */
  name?: string;
  title?: string;
  cover?: string;
  authors?: unknown;
  types?: unknown;
  status?: unknown;
  last_name?: string;
  alias_name?: string;
}

interface ZaiChapterItem {
  chapter_id?: number | string;
  chapter_title?: string;
  chapter_name?: string;
  is_fee?: boolean;
  canRead?: boolean;
}

interface ZaiDetail {
  id?: number | string;
  title?: string;
  aliasName?: string;
  cover?: string;
  description?: string;
  authors?: unknown;
  types?: unknown;
  status?: unknown;
  chapters?: { title?: string; data?: ZaiChapterItem[] }[];
}

/* ——————————————— 内部工具 ——————————————— */

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetchUpstream(`${API_BASE}/${path}`, {
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    signal,
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`再漫画请求失败: HTTP ${res.status}`);
  const json = (await res.json()) as { errno?: number; errmsg?: string; data?: T };
  // errno 非 0 是上游业务错误（比如搜索参数名写成 q 时的「请输入搜索的内容」）
  if (json.errno !== undefined && json.errno !== 0) {
    throw new Error(`再漫画返回错误: ${json.errmsg || `errno=${json.errno}`}`);
  }
  return json.data as T;
}

/** 列表条目 → 统一 MangaItem */
function toItem(item: ZaiListItem): MangaItem {
  const id = pickId(item);
  const title = (item.title || item.name || '').trim();
  return {
    id,
    title: title || '(无标题)',
    altTitles: [item.alias_name, item.last_name].filter(
      (s): s is string => !!s && s.trim().length > 0 && s.trim() !== title
    ),
    description: '',
    cover: item.cover || null,
    status: parseStatus(item.status),
    year: null,
    authors: parseNames(item.authors),
    tags: parseTags(item.types),
    // 上游没有分级字段。再漫画是正规平台，统一按 safe 处理；
    // 成人内容的过滤由 MangaDex 侧的 contentRating 负责。
    contentRating: 'safe',
    chapterCount: null,
    // 内容全部是汉化，标中文便于前端展示来源
    originalLanguage: 'zh',
  };
}

/** 从详情的 chapters 分组里拉平所有章节，按话数升序 */
function flattenChapters(chapters: ZaiDetail['chapters'], comicId: string): MangaChapter[] {
  const out: MangaChapter[] = [];
  for (const group of chapters || []) {
    for (const c of group.data || []) {
      const chapterId = c.chapter_id != null ? String(c.chapter_id) : '';
      if (!chapterId) continue;
      out.push({
        id: encodeZaiChapter(comicId, chapterId),
        // chapter_title 形如「20话」，只取前面的数字部分
        number: (c.chapter_title || '').match(/^\d+(?:\.\d+)?/)?.[0] ?? null,
        title: c.chapter_name || c.chapter_title || null,
        language: 'zh',
        pages: 0,
      });
    }
  }
  out.sort((a, b) => (parseFloat(a.number || '0') || 0) - (parseFloat(b.number || '0') || 0));
  return out;
}

/* ——————————————— 对外接口 ——————————————— */

/**
 * 搜索。
 *
 * ⚠️ 参数名是 **`keyword`**，不是 `q` / `wd` —— 写错会返回
 * `errno=1 请输入搜索的内容`（这个坑踩过一次）。
 */
export async function searchZaimanhua(
  keyword: string,
  opts: { page?: number; signal?: AbortSignal } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const q = encodeURIComponent(keyword.trim());
  const data = await getJSON<{ list?: ZaiListItem[]; total?: number }>(
    `search/index?keyword=${q}&page=${page}`,
    opts.signal
  );
  const list = data?.list || [];
  const items = list.map(toItem).filter((i) => i.id);
  return {
    items: await dropDeadEntries(items, opts.signal),
    total: data?.total ?? list.length,
  };
}

/**
 * 剔除上游已下架的条目。
 *
 * **实测**：搜索索引里混着大量已删除作品。搜「龙」返回 20 条，
 * 前 4 条点进去全是 `errno=2 漫画不存在或已被删除`；而搜「尾巴与逆鳞」
 * 命中的那条就正常。列表接口（`filter/list`）没有这个问题，
 * 只有 `search/index` 有。
 *
 * 枚举过能「零成本判断」的字段，全部失败：搜索结果把
 * `last_updatetime` / `last_update_chapter_id` 一律置 0（有效作品也一样），
 * 只有 `hot_hits` 有差异但阈值不可靠。所以只能逐条问详情。
 *
 * 两个保守策略：
 * - **验证请求本身失败时保留该条**（网络抖动/限流不该让用户搜不到东西）；
 * - **过滤后一条不剩时退回原列表** —— 宁可让用户点开后看到「已下架」提示，
 *   也好过显示「没有找到相关漫画」这种假象。
 */
async function dropDeadEntries(items: MangaItem[], signal?: AbortSignal): Promise<MangaItem[]> {
  if (items.length === 0) return items;

  const kept = await mapWithConcurrency(
    items,
    SEARCH_VERIFY_CONCURRENCY,
    async (item) => {
      try {
        const res = await fetchUpstream(`${API_BASE}/comic/detail/${item.id}`, {
          timeoutMs: TIMEOUT_MS,
          retries: 0, // 验证失败就当保留，不浪费重试
          signal,
          headers: HEADERS,
        });
        if (!res.ok) return item;
        const json = (await res.json()) as { errno?: number; data?: { data?: unknown } };
        // errno=2 = 漫画不存在或已被删除
        return json.errno === 0 && json.data?.data ? item : null;
      } catch {
        return item;
      }
    },
    // 任务抛错时保守保留
    (item) => item
  );

  const alive = kept.filter((i): i is MangaItem => i !== null);
  return alive.length > 0 ? alive : items;
}

/** 验证并发数：搜索一页 20 条，6 个一批约 4 批 */
const SEARCH_VERIFY_CONCURRENCY = 6;

/** 筛选浏览的参数（取值全部经白名单校验） */
export interface ZaiBrowseParams {
  /** 题材（theme） */
  theme?: string | null;
  /** 地区（zone）：2308 内地 / 2304 日本 / 2305 韩国 / 2306 欧美 / 2307 港台 */
  zone?: string | null;
  /** 受众（cate）：3262 少年 / 3263 少女 / 3264 青年 / 13626 女青 */
  cate?: string | null;
  /** 连载状态（status）：2309 连载中 / 2310 已完结 / 29205 短篇 */
  status?: string | null;
  /** 排序：latest = 最近更新，popular = 人气 */
  sort?: string | null;
  page?: number;
}

/**
 * 按题材 / 地区 / 受众 / 状态筛选浏览。
 *
 * 所有取值都过 `zaiAllow` 白名单，非法值回落「全部」而不是直接拼进 URL。
 */
export async function browseZaimanhua(
  params: ZaiBrowseParams = {},
  opts: { signal?: AbortSignal } = {}
): Promise<{ items: MangaItem[]; total: number }> {
  const page = Math.max(1, params.page ?? 1);
  const sp = new URLSearchParams({
    status: zaiAllow(params.status, ZAI_STATUSES),
    theme: zaiAllow(params.theme, ZAI_CATEGORIES),
    zone: zaiAllow(params.zone, ZAI_ZONES),
    cate: zaiAllow(params.cate, ZAI_CATES),
    sortType: String(zaiSortType(params.sort)),
    page: String(page),
    size: String(ZAI_PAGE_SIZE),
  });

  const data = await getJSON<{ comicList?: ZaiListItem[]; totalNum?: number }>(
    `comic/filter/list?${sp.toString()}`,
    opts.signal
  );
  const list = data?.comicList || [];
  return {
    items: list.map(toItem).filter((i) => i.id),
    total: data?.totalNum ?? list.length,
  };
}

/** 排行榜：`by_time` 0 日 / 1 周 / 2 月 / 3 总 */
export async function rankZaimanhua(
  opts: { byTime?: 0 | 1 | 2 | 3; page?: number; signal?: AbortSignal } = {}
): Promise<{ items: MangaItem[] }> {
  const page = Math.max(1, opts.page ?? 1);
  const byTime = opts.byTime ?? 0;
  const data = await getJSON<ZaiListItem[]>(
    `comic/rank/list?page=${page}&rank_type=0&by_time=${byTime}`,
    opts.signal
  );
  const list = Array.isArray(data) ? data : [];
  return { items: list.map(toItem).filter((i) => i.id) };
}

/** 详情 + 章节列表 */
export async function getZaimanhuaDetail(
  comicId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<{ item: MangaItem; chapters: MangaChapter[] }> {
  if (!COMIC_ID_RE.test(comicId)) throw new Error('再漫画 id 非法');
  const data = await getJSON<{ data?: ZaiDetail }>(`comic/detail/${comicId}`, opts.signal);
  const d = data?.data;
  if (!d) throw new Error('漫画不存在');

  const item: MangaItem = {
    id: comicId,
    title: d.title?.trim() || '(无标题)',
    altTitles: [d.aliasName].filter((s): s is string => !!s && s.trim().length > 0),
    description: d.description?.trim() || '',
    cover: d.cover || null,
    status: parseStatus(d.status),
    year: null,
    authors: parseNames(d.authors),
    tags: parseTags(d.types),
    contentRating: 'safe',
    chapterCount: null,
    originalLanguage: 'zh',
  };
  return { item, chapters: flattenChapters(d.chapters, comicId) };
}

/**
 * 取某章的图片地址列表。
 * 上游返回 `data.data.page_url`（双层 data），URL 带 `sign` + `t` 时效签名，
 * 所以结果只做短时缓存，不能长期保存。
 */
export async function getZaimanhuaChapterPages(
  comicId: string,
  chapterId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<string[]> {
  if (!COMIC_ID_RE.test(comicId) || !COMIC_ID_RE.test(chapterId)) {
    throw new Error('再漫画章节 id 非法');
  }
  const data = await getJSON<{ data?: { page_url?: string[] } }>(
    `comic/chapter/${comicId}/${chapterId}`,
    opts.signal
  );
  return (data?.data?.page_url || []).filter(
    (u) => typeof u === 'string' && u.startsWith('https://')
  );
}
