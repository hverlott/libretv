import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getLocalIndex, isLocalChapterId, readLocalPage } from '@/lib/local-manga';
import { getChapterImageUrls } from '@/lib/manga-sources';
import { handleProxyRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单章图片地址的内存缓存。
 *
 * MangaDex 的 at-home 接口有速率限制，再漫画的图片 URL 带 `sign` + `t`
 * 时效签名（虽然实测有效期比一次阅读长得多，但仍不该长期保存）。
 */
const pagesCache = new Map<string, { at: number; urls: string[] }>();
const PAGES_TTL_MS = 30 * 60 * 1000;
const PAGES_CACHE_MAX = 200;

/**
 * 漫画图片同源代理。
 * GET /api/manga/image?c=<chapterId>&i=<页序号>
 *
 * ## 为什么必须代理
 *
 * 漫画图片在 MangaDex 的 `*.mangadex.network` / 再漫画的 `images.zaimanhua.com`
 * 上。若阅读器直接用上游地址，浏览器会直连该 CDN，**用户真实 IP 随之暴露**——
 * 这与播放链路早期 `hls.loadSource(上游地址)` 是同一个问题
 * （见 PRIVACY.md「播放走同源代理」）。
 *
 * 因此这里按 chapterId + 页码现取上游地址，再经 `handleProxyRequest`
 * 流式转发，浏览器全程只与本机通信。
 *
 * 源按章节 id 自动判断：MangaDex 是 UUID，再漫画是 `z{漫画id}.{章节id}`。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const chapter = (sp.get('c') || '').trim().slice(0, 64);
  const index = parseInt(sp.get('i') || '0', 10) || 0;
  if (!chapter) return new NextResponse('缺少章节 id', { status: 400 });
  if (index < 0) return new NextResponse('页码非法', { status: 400 });

  // 本地漫画库：直接从本机目录 / 压缩包里读，不走代理（本来就没有上游）
  if (isLocalChapterId(chapter)) {
    await getLocalIndex();
    const page = await readLocalPage(chapter, index);
    if (!page) return new NextResponse('页面不存在', { status: 404 });
    return new NextResponse(new Uint8Array(page.data), {
      headers: {
        'content-type': page.mime,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  // 1. 取该章的图片地址（带缓存，降低上游压力）
  let entry = pagesCache.get(chapter);
  if (!entry || Date.now() - entry.at > PAGES_TTL_MS) {
    try {
      const urls = await getChapterImageUrls(chapter);
      entry = { at: Date.now(), urls };
      if (pagesCache.size >= PAGES_CACHE_MAX) {
        // 淘汰最旧一条，避免无限增长
        const oldest = [...pagesCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) pagesCache.delete(oldest[0]);
      }
      pagesCache.set(chapter, entry);
    } catch (err) {
      return new NextResponse(
        `章节图片获取失败: ${err instanceof Error ? err.message : '未知错误'}`,
        { status: 502 }
      );
    }
  }

  // 2. 取第 index 页的上游地址
  const upstream = entry.urls[index];
  if (!upstream) return new NextResponse('页码超出范围', { status: 404 });

  // 3. 经同源代理转发（复用点播图片同一套逻辑，含防盗链与重试）
  return handleProxyRequest(req, upstream);
}
