/**
 * 服务端下载任务队列。
 *
 * 结构：批次（Batch）→ 任务（Task，每集一个）。
 * - 批次对应用户一次「一键多选下载」操作，含 N 部影片 × M 集；
 * - 任务队列在进程内调度，状态落盘到 `<下载目录>/.queue.json`，
 *   进程重启后能恢复未完成任务的展示（但不会自动续传——分片不缓存）。
 *
 * 调度：同时进行的任务数由配置控制（默认 2），
 * 单个任务内部的分片并发由 segmentConcurrency 控制（默认 8）。
 * 两者相乘即对源站的实际压力上限。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDownloadConfig, getFreeSpaceBytes } from './download-config';
import {
  buildOutputFilePath,
  downloadEpisodeToFile,
  sanitizeFileName,
  ServerDownloadError,
  type ServerDownloadResult,
} from './server-download';

export type DownloadTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface DownloadTask {
  id: string;
  batchId: string;
  /** 影片名（不含集号） */
  title: string;
  /** 集号（1 基） */
  episode: number;
  /** 该集的总集数（用于文件名与进度展示） */
  totalEpisodes: number;
  /** m3u8 地址 */
  url: string;
  status: DownloadTaskStatus;
  /** 已完成分片 */
  finished: number;
  /** 总分片 */
  total: number;
  /** 已下载字节 */
  bytes: number;
  /** 输出文件路径（完成后有效） */
  filePath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadBatch {
  id: string;
  /** 用户给批次的备注（通常是影片名列表摘要） */
  label: string;
  taskIds: string[];
  createdAt: number;
}

export interface QueueSnapshot {
  batches: DownloadBatch[];
  tasks: DownloadTask[];
}

interface QueueState {
  batches: Map<string, DownloadBatch>;
  tasks: Map<string, DownloadTask>;
  /** 运行中的任务 → 中止控制器 */
  running: Map<string, AbortController>;
}

const state: QueueState = {
  batches: new Map(),
  tasks: new Map(),
  running: new Map(),
};

let stateFile: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 队列是否已从磁盘载入。
 *
 * 必须只载一次：内存态是权威（正在下载的任务只有内存里有），
 * 每次请求都重载磁盘快照会把这批内存任务整个冲掉——
 * 表现为「提交 3 集，只下了第 1 集，其余永远停在排队中」。
 */
let loaded = false;

// —— 持久化 ——

/** 字节数转可读体积 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function queueFilePath(): string {
  if (!stateFile) {
    stateFile = join(getDownloadConfig().dir, '.queue.json');
  }
  return stateFile;
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 1000);
}

export async function persistNow(): Promise<void> {
  const path = queueFilePath();
  const snapshot: QueueSnapshot = {
    batches: [...state.batches.values()],
    tasks: [...state.tasks.values()].map((t) => ({ ...t, status: t.status === 'running' ? 'queued' : t.status })),
  };
  try {
    await mkdir(getDownloadConfig().dir, { recursive: true });
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch {
    // 落盘失败不影响下载本身
  }
}

export async function loadQueue(): Promise<void> {
  // 已载入过就直接返回：内存态包含正在下载的任务与新提交的任务，
  // 磁盘快照只是启动时的初始状态，重载会丢掉它们
  if (loaded) return;
  loaded = true;

  const path = queueFilePath();
  try {
    const raw = await readFile(path, 'utf-8');
    const snapshot = JSON.parse(raw) as QueueSnapshot;
    state.batches.clear();
    state.tasks.clear();
    for (const b of snapshot.batches ?? []) state.batches.set(b.id, b);
    for (const t of snapshot.tasks ?? []) {
      // 进程重启后运行中的任务实际已中断，降级为排队（由调度器重新拉起）
      state.tasks.set(t.id, { ...t, status: t.status === 'running' ? 'queued' : t.status });
    }
  } catch {
    // 没有历史文件或解析失败：从空队列开始
  }
}

// —— 入队 ——

export interface EnqueueEpisode {
  title: string;
  episode: number;
  totalEpisodes: number;
  url: string;
}

export interface EnqueueResult {
  batchId: string;
  taskIds: string[];
  /** 因超出单批上限被截断的集数 */
  truncated: number;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * 把一个批次加入队列。
 * episodes 已经是「影片 × 集」展开后的扁平列表——
 * 展开逻辑在 API 层（要先拿到每部的详情）。
 */
export function enqueueBatch(label: string, episodes: EnqueueEpisode[]): EnqueueResult {
  const config = getDownloadConfig();
  const limit = config.maxEpisodesPerBatch;
  const accepted = episodes.slice(0, limit);
  const truncated = episodes.length - accepted.length;

  const batchId = nextId('batch');
  const taskIds: string[] = [];
  const now = Date.now();

  for (const ep of accepted) {
    const id = nextId('task');
    taskIds.push(id);
    state.tasks.set(id, {
      id,
      batchId,
      title: ep.title,
      episode: ep.episode,
      totalEpisodes: ep.totalEpisodes,
      url: ep.url,
      status: 'queued',
      finished: 0,
      total: 0,
      bytes: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  state.batches.set(batchId, { id: batchId, label, taskIds, createdAt: now });
  schedulePersist();
  scheduleNext();
  return { batchId, taskIds, truncated };
}

// —— 调度 ——

/**
 * 启动下一个排队中的任务。
 * 调度是「拉取式」：任务完成时主动调一次，避免轮询。
 */
export function scheduleNext(): void {
  const config = getDownloadConfig();
  if (state.running.size >= config.concurrency) return;

  const next = [...state.tasks.values()]
    .filter((t) => t.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;

  void startTask(next);
}

async function startTask(task: DownloadTask): Promise<void> {
  const config = getDownloadConfig();
  const abort = new AbortController();
  state.running.set(task.id, abort);
  task.status = 'running';
  task.updatedAt = Date.now();
  task.error = undefined;
  schedulePersist();

  try {
    // 磁盘空间检查：单集可达数 GB（实测有 139 分钟 / 2.5GB 的片源），
    // 空间不足时写到一半会留下损坏文件并让整批失败，不值当
    if (config.minFreeSpaceBytes > 0) {
      const free = await getFreeSpaceBytes(config.dir);
      if (free !== undefined && free < config.minFreeSpaceBytes) {
        throw new ServerDownloadError(
          `磁盘剩余空间不足（${formatBytes(free)}），已暂停下载。请清理磁盘后重试`,
          'write-failed'
        );
      }
    }
    const result = await runTask(task, config, abort.signal);
    task.status = 'completed';
    task.filePath = result.filePath;
    task.bytes = result.bytes;
    task.finished = result.segments;
    task.total = result.segments;
  } catch (err) {
    if (abort.signal.aborted) {
      task.status = 'canceled';
      task.error = '已取消';
    } else {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      // 保留堆栈：转封装/解密的内部错误只有栈能定位到具体调用点
      const cause =
        err instanceof Error && 'cause' in err && typeof (err as { cause?: unknown }).cause === 'string'
          ? (err as { cause?: string }).cause
          : err instanceof Error
            ? err.stack
            : undefined;
      if (cause) {
        console.error(
          `[LibreTV] 下载任务失败（${task.title} 第${task.episode}集）:`,
          cause
        );
      }
    }
  } finally {
    task.updatedAt = Date.now();
    state.running.delete(task.id);
    schedulePersist();
    // 继续拉下一个
    scheduleNext();
  }
}

async function runTask(
  task: DownloadTask,
  config: ReturnType<typeof getDownloadConfig>,
  signal: AbortSignal
): Promise<ServerDownloadResult> {
  const ext = config.format === 'TS' ? 'ts' : 'mp4';
  // 文件名：多集时带集号，单集影片就是纯标题
  const fileName =
    task.totalEpisodes > 1
      ? `${sanitizeFileName(task.title)} 第${task.episode}集`
      : sanitizeFileName(task.title);
  const outputPath = buildOutputFilePath(config.dir, fileName, ext);

  const result = await downloadEpisodeToFile({
    url: task.url,
    outputPath,
    format: config.format,
    concurrency: config.segmentConcurrency,
    signal,
    onProgress: (p) => {
      task.finished = p.finished;
      task.total = p.total;
      task.bytes = p.bytes;
      task.updatedAt = Date.now();
      // 进度也落盘：否则进程重启时快照里的分片数停在 0，
      // 用户会以为「从没开始下」而不是「下到一半被中断」
      schedulePersist();
    },
  });
  return result;
}

// —— 控制 ——

export function cancelTask(taskId: string): boolean {
  const abort = state.running.get(taskId);
  if (abort) {
    abort.abort();
    return true;
  }
  const task = state.tasks.get(taskId);
  if (task && task.status === 'queued') {
    task.status = 'canceled';
    task.error = '已取消';
    task.updatedAt = Date.now();
    schedulePersist();
    return true;
  }
  return false;
}

export function cancelBatch(batchId: string): number {
  const batch = state.batches.get(batchId);
  if (!batch) return 0;
  let count = 0;
  for (const taskId of batch.taskIds) {
    if (cancelTask(taskId)) count += 1;
  }
  return count;
}

export function removeTask(taskId: string): void {
  const task = state.tasks.get(taskId);
  if (!task) return;
  cancelTask(taskId);
  state.tasks.delete(taskId);
  // 从批次里摘掉
  for (const batch of state.batches.values()) {
    batch.taskIds = batch.taskIds.filter((id) => id !== taskId);
  }
  schedulePersist();
}

export function removeBatch(batchId: string): void {
  const batch = state.batches.get(batchId);
  if (!batch) return;
  for (const taskId of batch.taskIds) {
    cancelTask(taskId);
    state.tasks.delete(taskId);
  }
  state.batches.delete(batchId);
  schedulePersist();
}

/** 清空历史记录（不影响正在下载的任务） */
export function clearFinished(): void {
  for (const [id, task] of [...state.tasks]) {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
      state.tasks.delete(id);
    }
  }
  for (const [id, batch] of [...state.batches]) {
    const remaining = batch.taskIds.filter((tid) => state.tasks.has(tid));
    if (remaining.length === 0) {
      state.batches.delete(id);
    } else {
      batch.taskIds = remaining;
    }
  }
  schedulePersist();
}

// —— 查询 ——

export function getSnapshot(): QueueSnapshot {
  return {
    batches: [...state.batches.values()].sort((a, b) => b.createdAt - a.createdAt),
    tasks: [...state.tasks.values()].sort((a, b) => a.createdAt - b.createdAt),
  };
}

export function getBatchStats(batchId: string): {
  total: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
  canceled: number;
  bytes: number;
} {
  const batch = state.batches.get(batchId);
  const tasks = batch ? batch.taskIds.map((id) => state.tasks.get(id)).filter(Boolean) : [];
  const stats = { total: tasks.length, completed: 0, failed: 0, running: 0, queued: 0, canceled: 0, bytes: 0 };
  for (const t of tasks) {
    if (!t) continue;
    if (t.status === 'completed') stats.completed += 1;
    else if (t.status === 'failed') stats.failed += 1;
    else if (t.status === 'running') stats.running += 1;
    else if (t.status === 'queued') stats.queued += 1;
    else if (t.status === 'canceled') stats.canceled += 1;
    stats.bytes += t.bytes;
  }
  return stats;
}
