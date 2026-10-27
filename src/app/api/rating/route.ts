import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { MAX_BATCH, inferKind, resolveRating, resolveRatings } from '@/lib/rating';
import type { RatingQuery, RatingResult } from '@/lib/rating';
import type { MediaKind } from '@/lib/rating/match';

export const runtime = 'nodejs';

/**
 * 评分补全。
 *
 * 入参是片名 —— 这本身是敏感信息（等于告诉上游「本机在看什么」），
 * 所以：① 必须登录；② 成人条目直接跳过，不往第三方发成人片名；
 * ③ 整体可用 RATING_PROVIDER=none 关掉，关掉后本接口直接返回空结果。
 */

const MAX_TITLE_LEN = 120;

interface IncomingItem {
  title?: unknown;
  year?: unknown;
  type?: unknown;
  /** 采集站类型名（「国产剧」「动作片」…），用于推断电影/剧集 */
  typeName?: unknown;
  adult?: unknown;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // 控制字符会污染上游 URL，统一剥掉
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function toKind(type: unknown, typeName: unknown): MediaKind | undefined {
  const raw = cleanText(type, 20).toLowerCase();
  if (raw === 'movie') return 'movie';
  if (raw === 'tv') return 'tv';
  return inferKind(cleanText(typeName, 40));
}

function normalize(item: IncomingItem): RatingQuery | null {
  const title = cleanText(item.title, MAX_TITLE_LEN);
  if (!title) return null;
  // 成人内容不外发：既避免把成人片名交给第三方，也省掉必然无效的查询
  if (item.adult === true) return null;
  const year = cleanText(item.year, 8);
  return { title, year: year || undefined, kind: toKind(item.type, item.typeName) };
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const query = normalize({
    title: url.searchParams.get('title'),
    year: url.searchParams.get('year'),
    type: url.searchParams.get('type'),
    typeName: url.searchParams.get('typeName'),
    adult: url.searchParams.get('adult') === '1',
  });
  if (!query) return jsonError('缺少标题', 400);

  const rating = await resolveRating(query);
  return NextResponse.json(
    { rating },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) return jsonError('items 必须是数组', 400);

  const items = rawItems.slice(0, MAX_BATCH).map((entry) => normalize(entry as IncomingItem));
  const results: Array<RatingResult | null> = await resolveRatings(
    items.map((item) => item ?? { title: '' })
  );

  // 被跳过的条目（成人 / 空标题）对应 null，位置与入参一一对应
  const ratings = results.map((rating, index) => (items[index] ? rating : null));

  return NextResponse.json({ ratings }, { headers: { 'Cache-Control': 'no-store' } });
}
