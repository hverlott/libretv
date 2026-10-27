import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getDownloadConfig } from '@/lib/download-config';
import {
  cancelBatch,
  cancelTask,
  clearFinished,
  enqueueBatch,
  getBatchStats,
  loadQueue,
  persistNow,
  removeBatch,
  removeTask,
  type EnqueueEpisode,
} from '@/lib/download-queue';
import { parseDetail, parseDetailPageHtml } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SourceConfig, VideoDetail } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * 服务端批量下载。
 *
 * POST /api/download/batch
 *   body: { items: [{ source: SourceConfig, vodId: string, title: string }], label? }
 *   → 服务端逐部取详情，把「影片 × 集」展开成下载任务，返回批次 ID 与统计
 *
 * DELETE /api/download/queue?taskId=xx | ?batchId=xx
 *   → 取消 / 删除
 */

const DETAIL_CACHE_TTL = 60 * 1000;
/** 同时取详情的影片数：太高会打爆源站，太低则 100 部要等太久 */
const DETAIL_CONCURRENCY = 8;

/**
 * 限流并发执行，逐个产出结果。
 * 不用 Promise.all 是因为一次性 100 个请求会打爆源站；
 * 不用串行是因为 100 部串行要等好几分钟。
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

interface BatchItem {
  source: SourceConfig;
  vodId: string;
  title: string;
  /** 只下前 N 集；不传则下全部 */
  maxEpisodes?: number;
}

/** 取一部影片的详情（带短缓存，与 /api/detail 同源） */
async function fetchDetail(source: SourceConfig, vodId: string): Promise<VideoDetail | null> {
  const detailRoot = (source.detail || new URL(source.url).origin).replace(/\/+$/, '');
  const cacheKey = `detail:${source.url}|${detailRoot}|${vodId}`;
  const cached = getCache<VideoDetail>(cacheKey);
  if (cached) return cached;

  const listVerdict = await checkUpstreamAllowed(source.url);
  if (!listVerdict.ok) return null;

  // 1) 标准列表接口
  const api = `${source.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(vodId)}`;
  const res = await fetchUpstream(api, { timeoutMs: 10_000, headers: cmsHeaders() });
  if (res.ok) {
    try {
      const detail = parseDetail(await res.json(), source);
      if (detail.episodes.length > 0) {
        setCache(cacheKey, detail, DETAIL_CACHE_TTL);
        return detail;
      }
    } catch {
      // 列表接口无内容 → 尝试详情页
    }
  }

  // 2) 详情页 HTML 提取
  if (/^https?:\/\//.test(detailRoot)) {
    const detailVerdict = await checkUpstreamAllowed(detailRoot);
    if (!detailVerdict.ok) return null;
    const detailUrl = `${detailRoot}/index.php/vod/detail/id/${vodId}.html`;
    const detailRes = await fetchUpstream(detailUrl, { timeoutMs: 10_000, headers: cmsHeaders() });
    if (detailRes.ok) {
      const detail = parseDetailPageHtml(await detailRes.text(), source);
      if (detail.episodes.length > 0) {
        setCache(cacheKey, detail, DETAIL_CACHE_TTL);
        return detail;
      }
    }
  }
  return null;
}

function cmsHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { items?: BatchItem[]; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return NextResponse.json({ error: '没有选择要下载的影片' }, { status: 400 });
  }
  if (items.length > 100) {
    return NextResponse.json({ error: '一次最多提交 100 部影片' }, { status: 400 });
  }

  await loadQueue();

  // 并发取详情，展开成「影片 × 集」。
  // 串行会让 100 部影片的展开耗时叠加到分钟级（每部要打一次源站），
  // 用户点完按钮要干等——因此这里用限流并发，实测 100 部约 10 秒内完成。
  const episodes: EnqueueEpisode[] = [];
  const failures: { title: string; reason: string }[] = [];
  const resolved: { title: string; episodeCount: number }[] = [];

  await mapWithConcurrency(items, DETAIL_CONCURRENCY, async (item) => {
    const source = item.source;
    if (!source?.url || !/^https?:\/\//.test(source.url)) {
      failures.push({ title: item.title, reason: '点播源配置无效' });
      return;
    }
    if (!item.vodId) {
      failures.push({ title: item.title, reason: '缺少影片 ID' });
      return;
    }
    let detail: VideoDetail | null = null;
    try {
      detail = await fetchDetail(source, item.vodId);
    } catch (err) {
      failures.push({
        title: item.title,
        reason: err instanceof Error ? err.message : '获取详情失败',
      });
      return;
    }
    if (!detail || detail.episodes.length === 0) {
      failures.push({ title: item.title, reason: '未找到播放资源' });
      return;
    }
    const limit = item.maxEpisodes ?? detail.episodes.length;
    const count = Math.min(limit, detail.episodes.length);
    for (let i = 0; i < count; i++) {
      episodes.push({
        title: item.title,
        episode: i + 1,
        totalEpisodes: count,
        url: detail.episodes[i],
      });
    }
    resolved.push({ title: item.title, episodeCount: count });
  });

  if (episodes.length === 0) {
    return NextResponse.json(
      { error: '所有影片都没有可下载的播放地址', failures },
      { status: 400 }
    );
  }

  const label =
    body.label?.trim() ||
    (resolved.length === 1 ? resolved[0].title : `${resolved.length} 部影片`);

  const result = enqueueBatch(label, episodes);
  const stats = getBatchStats(result.batchId);
  const config = getDownloadConfig();

  return NextResponse.json({
    batchId: result.batchId,
    taskIds: result.taskIds,
    episodeCount: episodes.length,
    truncated: result.truncated,
    stats,
    failures,
    resolved,
    downloadDir: config.dir,
    format: config.format,
  });
}

export async function DELETE(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId');
  const batchId = url.searchParams.get('batchId');
  const action = url.searchParams.get('action');

  if (action === 'clear') {
    clearFinished();
    await persistNow();
    return NextResponse.json({ ok: true });
  }
  if (taskId) {
    const canceled = cancelTask(taskId);
    if (canceled) removeTask(taskId);
    await persistNow();
    return NextResponse.json({ ok: true, canceled });
  }
  if (batchId) {
    const canceled = cancelBatch(batchId);
    removeBatch(batchId);
    await persistNow();
    return NextResponse.json({ ok: true, canceled });
  }
  return NextResponse.json({ error: '缺少 taskId 或 batchId' }, { status: 400 });
}
