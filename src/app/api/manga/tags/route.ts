import { isWebtoonSource } from '@/lib/webtoon-parser';
import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getMangaTags } from '@/lib/mangadex';
import { resolveMangaSource } from '@/lib/manga-sources';
import { getZaimanhuaCategories } from '@/lib/zaimanhua';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 漫画可筛选标签。
 * GET /api/manga/tags?source=zaimanhua|mangadex
 *
 * - MangaDex：题材 / 主题 / 形式三组，来自上游 `/manga/tag`。
 *   内容警示与未成年性化题材（见 `EXCLUDED_TAGS`）不会作为分类入口返回，
 *   服务端缓存 12 小时，上游抖动时降级用旧缓存。
 * - 再漫画：只有题材一组，是内置静态表（上游没有标签接口）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const source = resolveMangaSource(sp.get('source'));

  if (isWebtoonSource(source)) return NextResponse.json({ groups: [] });

  if (source === 'zaimanhua') {
    return NextResponse.json(
      { groups: [{ group: 'genre', label: '题材', tags: getZaimanhuaCategories() }] },
      { headers: { 'Cache-Control': 'private, max-age=3600' } }
    );
  }

  try {
    const data = await getMangaTags();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '漫画标签获取失败' },
      { status: 502 }
    );
  }
}
