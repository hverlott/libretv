import { fetchUpstream } from './fetch-utils';
import type { MangaChapter, MangaItem } from './types';
import { WEBTOON_CONFIG, decodeWebtoonId, parseWebtoonCatalog, parseWebtoonChapters, parseWebtoonImages, type WebtoonSource } from './webtoon-parser';

const catalogs = new Map<WebtoonSource, { at: number; items: MangaItem[] }>();
const details = new Map<string, { at: number; chapters: MangaChapter[] }>();
const TTL = 10 * 60 * 1000;
async function readHtml(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchUpstream(url, { signal, timeoutMs: 15000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) throw new Error(`漫画源暂不可用（${res.status}）`);
  const html = await res.text();
  if (html.length > 4_000_000) throw new Error('漫画源返回内容过大');
  return html;
}
async function catalog(source: WebtoonSource, signal?: AbortSignal): Promise<MangaItem[]> {
  const cached = catalogs.get(source);
  if (cached && Date.now() - cached.at < TTL) return cached.items;
  const c = WEBTOON_CONFIG[source];
  const first = await readHtml(c.root + c.catalog, signal);
  const indexed = new Map(parseWebtoonCatalog(first, source).map(item => [item.id, item]));
  // WEBTOON now renders one weekday at a time. Read every linked weekday,
  // otherwise most of the catalog silently disappears from search.
  if (source !== 'dongman') {
    const links = [...new Set([...first.matchAll(/href="(https:\/\/www\.webtoons\.com\/(?:en|zh-hant)\/originals\/[a-z]+)(?:\?[^" ]*)?"/g)].map(m => m[1]))].filter(url => url.startsWith(c.root + c.prefix + '/')).slice(0, 9);
    for (let start = 0; start < links.length; start += 3) {
      const htmls = await Promise.all(links.slice(start, start + 3).map(url => readHtml(url, signal)));
      for (const html of htmls) for (const item of parseWebtoonCatalog(html, source)) indexed.set(item.id, item);
    }
  }
  const items = [...indexed.values()];
  if (!items.length) throw new Error('漫画源目录暂不可用，请稍后重试');
  catalogs.set(source, { at: Date.now(), items });
  return items;
}
export async function browseWebtoon(source: WebtoonSource, options: { page?: number; limit?: number; keyword?: string; signal?: AbortSignal } = {}) {
  const all = await catalog(source, options.signal);
  const q = (options.keyword || '').normalize('NFKC').toLocaleLowerCase();
  const items = q ? all.filter(item => [item.title, ...(item.authors || [])].some(t => t.normalize('NFKC').toLocaleLowerCase().includes(q))) : all;
  const limit = Math.min(50, Math.max(1, options.limit || 24));
  const offset = (Math.max(1, options.page || 1) - 1) * limit;
  return { items: items.slice(offset, offset + limit), total: items.length };
}
export async function getWebtoonDetail(id: string, signal?: AbortSignal) {
  const decoded = decodeWebtoonId(id);
  if (!decoded || decoded.episode) throw new Error('漫画 id 非法');
  const item = (await catalog(decoded.source, signal)).find(i => i.id === id);
  if (!item) throw new Error('作品不在当前公开目录中');
  const config = WEBTOON_CONFIG[decoded.source];
  let cached = details.get(id);
  if (!cached || Date.now() - cached.at >= TTL) {
    const root = item.sourceUrl!;
    const first = await readHtml(root, signal);
    const chapters = new Map(parseWebtoonChapters(first, id).map(c => [c.id, c]));
    // The public reader includes the complete chapter navigation. One extra
    // HTML request avoids fetching dozens of paginated catalog pages on mobile.
    const sample = chapters.values().next().value;
    if (sample) {
      const reader = new URL(root);
      reader.pathname = reader.pathname.replace(/\/list$/, '/episode/viewer');
      reader.searchParams.set('episode_no', sample.id.split('.')[1]);
      const navigation = parseWebtoonChapters(await readHtml(reader.href, signal), id);
      for (const chapter of navigation) chapters.set(chapter.id, chapter);
    }
    cached = { at: Date.now(), chapters: [...chapters.values()].sort((a, b) => Number(a.id.split('.')[1]) - Number(b.id.split('.')[1])) };
    if (!cached.chapters.length) throw new Error('暂无公开网页章节，请到官方平台查看');
    if (details.size >= 100) details.delete(details.keys().next().value!);
    details.set(id, cached);
  }
  return { ...item, chapters: cached.chapters, chapterLanguage: config.language, chapterCount: cached.chapters.length };
}
export async function getWebtoonPages(id: string, signal?: AbortSignal): Promise<string[]> {
  const decoded = decodeWebtoonId(id);
  if (!decoded?.episode) throw new Error('章节 id 非法');
  const titleId = id.split('.')[0];
  const item = (await catalog(decoded.source, signal)).find(i => i.id === titleId);
  if (!item) throw new Error('作品不在当前公开目录中');
  const reader = new URL(item.sourceUrl!);
  reader.pathname = reader.pathname.replace(/\/list$/, "/episode/viewer");
  reader.searchParams.set("episode_no", decoded.episode);
  const html = await readHtml(reader.href, signal);
  const images = parseWebtoonImages(html, decoded.source);
  if (!images.length) throw new Error('本章没有公开网页图片，可能需要在官方平台登录、付费或使用 App');
  return images;
}
