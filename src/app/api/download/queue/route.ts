import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import {
  getBatchStats,
  getSnapshot,
  loadQueue,
  type DownloadBatch,
  type DownloadTask,
} from '@/lib/download-queue';

export const runtime = 'nodejs';

/**
 * 下载队列快照：批次 + 任务 + 进度。
 * 前端轮询这个接口渲染下载中心。
 */
export interface QueueResponse {
  batches: DownloadBatch[];
  tasks: DownloadTask[];
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  await loadQueue();
  const snapshot = getSnapshot();
  return NextResponse.json({
    ...snapshot,
    // 各批次统计（前端展示「已完成 3/12」）
    batchStats: Object.fromEntries(
      snapshot.batches.map((b) => [b.id, getBatchStats(b.id)])
    ),
  } satisfies QueueResponse & { batchStats: Record<string, unknown> });
}
