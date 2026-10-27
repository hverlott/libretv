import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { browseMangaAny, resolveMangaSource } from '@/lib/manga-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 漫画分类浏览。
 * GET /api/manga/browse?source=zaimanhua|mangadex&tags=<id>&demo=&status=
 *                      &lang=&origin=&rating=&sort=latest&page=1&limit=24
 *
 * 两个源的筛选维度不同，但共用同一组参数位：
 *
 * | 参数 | MangaDex | 再漫画 |
 * |---|---|---|
 * | `tags` | 标签 id（多选 AND） | 题材 id（单选，取第一个） |
 * | `demo` | 受众 shounen… | 受众 3262 少年… |
 * | `status` | ongoing / completed… | 2309 连载中 / 2310 已完结… |
 * | `lang` | 有某语言译本 | 不适用 |
 * | `origin` | 原作语言 ja / ko… | 地区 2308 内地 / 2304 日本 / 2305 韩国… |
 * | `sort` | latest / popular… | latest / popular |
 *
 * - `rating=erotica` 只对 MangaDex 生效（再漫画没有分级字段）
 * - 涉及未成年性化的标签在 MangaDex 侧的所有请求里都被上游排除，与以上参数无关
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const source = resolveMangaSource(sp.get('source'));

  const tags = (sp.get('tags') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64)
    .slice(0, 8);

  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') || '24', 10) || 24));
  const includeAdult = sp.get('adult') === '1';

  try {
    const { items, total } = await browseMangaAny(source, {
      tags,
      demo: sp.get('demo'),
      status: sp.get('status'),
      lang: sp.get('lang'),
      origin: sp.get('origin'),
      // 白名单校验在各源客户端里做，这里只负责透传
      rating: sp.get('rating'),
      sort: sp.get('sort'),
      page,
      limit,
      includeAdult,
    });
    return NextResponse.json({ items, total, source });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '漫画列表获取失败' },
      { status: 502 }
    );
  }
}
