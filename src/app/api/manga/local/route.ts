import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getLocalIndex, isLocalLibraryEnabled, toWorkSummary } from '@/lib/local-manga';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 本地漫画库书单。
 * GET /api/manga/local            —— 取书库（带 5 分钟索引缓存）
 * GET /api/manga/local?refresh=1  —— 强制重新扫描目录
 *
 * 内容全部来自 `LOCAL_MANGA_DIR` 指向的目录，不访问任何在线源。
 * `configured=false` 表示没配这个环境变量，前端据此显示配置指引。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const force = sp.get('refresh') === '1';

  if (!isLocalLibraryEnabled()) {
    return NextResponse.json({ configured: false, works: [], total: 0, root: null, skipped: [] });
  }

  try {
    const index = await getLocalIndex({ force });
    const works = (index?.works ?? []).map(toWorkSummary);
    return NextResponse.json({
      configured: true,
      works,
      total: works.length,
      // 根目录回显给前端，方便确认配的是不是自己想要的那个目录
      root: index?.root ?? null,
      // 没收录的条目也回给前端：目录里明明有文件却扫不出来时，得有个说法
      skipped: index?.skipped ?? [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '本地书库扫描失败' },
      { status: 500 }
    );
  }
}
