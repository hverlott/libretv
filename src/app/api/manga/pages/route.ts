import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { findLocalChapter, getLocalIndex, isLocalChapterId } from '@/lib/local-manga';
import { getChapterImageUrls } from '@/lib/manga-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 章节图片地址列表。
 * GET /api/manga/pages?chapter=<chapterId>
 *
 * 源按章节 id 自动判断：MangaDex 是 UUID，再漫画是 `z{漫画id}.{章节id}`。
 *
 * 返回的是**本站同源代理地址**，不是上游 CDN 地址 —— 阅读器若直连上游
 * 会暴露用户真实 IP（与播放链路走 /api/proxy 同理）。
 *
 * 本地漫画库（`lc` 开头）同样返回代理地址，图片内容来自本机目录。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const chapter = (sp.get('chapter') || '').trim().slice(0, 64);
  if (!chapter) return NextResponse.json({ error: '缺少章节 id' }, { status: 400 });

  // 本地漫画库：页数直接从索引里取，不用打任何网络请求
  if (isLocalChapterId(chapter)) {
    await getLocalIndex();
    const hit = findLocalChapter(chapter);
    if (!hit) return NextResponse.json({ error: '本地章节不存在' }, { status: 404 });
    return NextResponse.json({
      images: hit.chapter.pages.map(
        (_, i) => `/api/manga/image?c=${encodeURIComponent(chapter)}&i=${i}`
      ),
      count: hit.chapter.pages.length,
    });
  }

  try {
    const urls = await getChapterImageUrls(chapter);
    return NextResponse.json({
      // 同源代理地址，前端直接用
      images: urls.map((_, i) => `/api/manga/image?c=${encodeURIComponent(chapter)}&i=${i}`),
      count: urls.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '章节图片获取失败' },
      { status: 502 }
    );
  }
}
