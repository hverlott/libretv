import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { normalizeMangaRating } from '@/lib/mangadex-tags';
import { resolveMangaSource, searchMangaAny } from '@/lib/manga-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 漫画搜索。
 * GET /api/manga/search?q=<关键词>&source=zaimanhua|mangadex&page=1&limit=20&rating=erotica|pornographic
 *
 * - `source` 省略时用默认源（再漫画，中文）
 * - `page` 从 1 开始；MangaDex 侧内部换算成 offset
 * - `rating` / `adult=1` 只对 MangaDex 生效（再漫画是正规平台，没有分级字段）；
 *   `rating=pornographic` 为限制级，向下包含 erotica
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const q = (sp.get('q') || '').trim().slice(0, 60);
  if (!q) return NextResponse.json({ error: '缺少搜索关键词' }, { status: 400 });

  const source = resolveMangaSource(sp.get('source'));
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(sp.get('limit') || '20', 10) || 20));
  const includeAdult = sp.get('adult') === '1';
  const rating = normalizeMangaRating(sp.get('rating'));

  try {
    const { items, total } = await searchMangaAny(source, q, { page, limit, includeAdult, rating });
    return NextResponse.json({ items, total, source });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '漫画搜索失败' },
      { status: 502 }
    );
  }
}
