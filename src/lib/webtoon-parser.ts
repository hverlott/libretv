import type { MangaChapter, MangaItem } from './types';

export type WebtoonSource = 'dongman' | 'webtoon-zh' | 'webtoon-en';
export const WEBTOON_CONFIG = {
  dongman: { root: 'https://www.dongmanmanhua.cn', prefix: '', code: 'd', language: 'zh', catalog: '/dailySchedule' },
  'webtoon-zh': { root: 'https://www.webtoons.com', prefix: '/zh-hant', code: 't', language: 'zh-hk', catalog: '/zh-hant/originals' },
  'webtoon-en': { root: 'https://www.webtoons.com', prefix: '/en', code: 'e', language: 'en', catalog: '/en/originals' },
} as const;
export function isWebtoonSource(source: string): source is WebtoonSource {
  return Object.hasOwn(WEBTOON_CONFIG, source);
}
export function decodeWebtoonId(id: string): { source: WebtoonSource; title: string; episode?: string } | null {
  const match = /^w([dte])(\d{1,9})(?:\.(\d{1,9}))?$/.exec(id);
  if (!match) return null;
  return { source: match[1] === 'd' ? 'dongman' : match[1] === 't' ? 'webtoon-zh' : 'webtoon-en', title: match[2], episode: match[3] };
}
export function htmlText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp|hellip);/g, (_, n: string) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…'}[n] || '')).trim();
}
function attr(tag: string, name: string): string {
  return htmlText(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] || '');
}
function classText(body: string, name: string): string {
  return htmlText(new RegExp(`<[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:p|strong|div|span)>`, 'i').exec(body)?.[1] || '');
}
export function parseWebtoonCatalog(html: string, source: WebtoonSource): MangaItem[] {
  const config = WEBTOON_CONFIG[source];
  const items = new Map<string, MangaItem>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], 'href');
    if (!href.includes('/list?') || !href.includes('title_no=')) continue;
    const url = new URL(href, config.root);
    if (url.origin !== config.root) continue;
    const titleId = url.searchParams.get('title_no');
    if (!titleId || !/^\d{1,9}$/.test(titleId)) continue;
    const body = match[2];
    // Only expose the general public catalog; do not surface age-gated categories.
    const genre = classText(body, 'genre');
    if (/大人系|romance-m|mature/i.test(genre + url.pathname) || /data-title-unsuitable-for-children="true"/.test(body)) continue;
    const title = classText(body, 'title') || classText(body, 'subj');
    if (!title) continue;
    const image = /<img\b[^>]*>/i.exec(body)?.[0] || '';
    const cover = attr(image, 'src');
    const id = `w${config.code}${titleId}`;
    items.set(id, { id, sourceUrl: url.href, title, altTitles: [], description: '公开网页章节；部分后续章节可能需在官方平台登录、付费或使用 App。', cover: cover.startsWith('https://') ? cover : null, status: null, year: null, tags: [], contentRating: 'safe', chapterCount: null, originalLanguage: null, authors: [classText(body, 'author')].filter(Boolean) });
  }
  return [...items.values()];
}
export function parseWebtoonChapters(html: string, id: string): MangaChapter[] {
  const decoded = decodeWebtoonId(id);
  if (!decoded || decoded.episode) throw new Error('漫画 id 非法');
  const chapters = new Map<string, MangaChapter>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], 'href');
    if (!href.includes('/viewer?')) continue;
    const url = new URL(href, WEBTOON_CONFIG[decoded.source].root);
    if (url.searchParams.get('title_no') !== decoded.title) continue;
    const episode = url.searchParams.get('episode_no');
    if (!episode || !/^\d{1,9}$/.test(episode)) continue;
    const title = classText(match[2], 'subj') || attr(/<img\b[^>]*>/i.exec(match[2])?.[0] || '', 'alt');
    // Ignore the separate "read first" CTA, which would overwrite the real title.
    if (!title) continue;
    const chapterId = `${id}.${episode}`;
    chapters.set(chapterId, { id: chapterId, title, number: /(?:第\s*|Ep\.?\s*)(\d+(?:\.\d+)?)/i.exec(title)?.[1] || episode, language: WEBTOON_CONFIG[decoded.source].language, pages: 0 });
  }
  return [...chapters.values()];
}
export function webtoonLastLinkedPage(html: string): number {
  return Math.min(100, Math.max(1, ...[...html.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map(m => Number(m[1]))));
}
export function parseWebtoonImages(html: string, source: WebtoonSource): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!attr(match[0], 'class').split(/\s+/).includes('_images')) continue;
    const value = attr(match[0], 'data-url');
    try {
      const url = new URL(value);
      const allowed = source === 'dongman' ? url.hostname === 'cdn.dongmanmanhua.cn' : /^(?:s?webtoon-phinf)\.pstatic\.net$/.test(url.hostname);
      if (url.protocol === 'https:' && allowed) urls.push(url.href);
    } catch { /* Ignore malformed upstream images. */ }
  }
  return [...new Set(urls)];
}
