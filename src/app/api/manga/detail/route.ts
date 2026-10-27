import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { findLocalWork, getLocalIndex, isLocalWorkId, toMangaItem } from '@/lib/local-manga';
import { normalizeMangaRating } from '@/lib/mangadex-tags';
import { detectMangaSource, getMangaDetailAny, resolveMangaSource } from '@/lib/manga-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 漫画详情 + 章节列表。
 * GET /api/manga/detail?id=<mangaId>&source=zaimanhua|mangadex&rating=erotica|pornographic
 *
 * `source` 可省略：UUID → MangaDex，纯数字 → 再漫画。
 * 阅读器翻页时只带 id，靠这个推断才不会走错源。
 *
 * `rating` 必须带上：限制级作品的详情与章节接口都会按 contentRating 过滤，
 * 不带对应档位时详情 404、章节列表返回 0 条。
 *
 * id 以 `lm` 开头时走**本地漫画库**，不经过任何在线源。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const id = (sp.get('id') || '').trim().slice(0, 64);
  if (!id) return NextResponse.json({ error: '缺少漫画 id' }, { status: 400 });

  // 本地漫画库：id 形态自带来源信息，不查任何在线源
  if (isLocalWorkId(id)) {
    await getLocalIndex();
    const work = findLocalWork(id);
    if (!work) {
      return NextResponse.json(
        { error: '本地作品不存在（可能已移出目录，刷新一下书库）' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ...toMangaItem(work), source: 'local' });
  }

  // 显式传了 source 就用它，否则按 id 形态推断
  const source = sp.get('source') ? resolveMangaSource(sp.get('source')) : detectMangaSource(id);
  const includeAdult = sp.get('adult') === '1';
  const rating = normalizeMangaRating(sp.get('rating'));

  try {
    const detail = await getMangaDetailAny(id, { source, includeAdult, rating });
    return NextResponse.json({ ...detail, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : '漫画详情获取失败';
    // 漫画不存在与网络故障都走 502，前端统一提示重试
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
