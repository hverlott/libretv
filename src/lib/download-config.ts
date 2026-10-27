/**
 * 服务端下载配置。
 *
 * 下载目录默认取项目下的 `downloads/`（本机部署即本机磁盘）。
 * 可用 DOWNLOAD_DIR 指定绝对路径；Windows 路径需写成正斜杠或双反斜杠。
 */
import { statfs } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface DownloadConfig {
  /** 下载根目录（绝对路径） */
  dir: string;
  /** 输出格式 */
  format: 'TS' | 'MP4';
  /** 同时下载的「集」数 */
  concurrency: number;
  /** 单集分片并发数 */
  segmentConcurrency: number;
  /** 单次批量提交的最大集数（防止误操作塞爆磁盘） */
  maxEpisodesPerBatch: number;
  /** 剩余磁盘空间低于此值时拒绝开始下载（字节） */
  minFreeSpaceBytes: number;
}

const DEFAULT_DIR = 'downloads';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SEGMENT_CONCURRENCY = 8;
const DEFAULT_MAX_EPISODES = 200;

export function getDownloadConfig(): DownloadConfig {
  const rawDir = process.env.DOWNLOAD_DIR?.trim();
  const dir = rawDir
    ? isAbsolute(rawDir)
      ? resolve(rawDir)
      : resolve(process.cwd(), rawDir)
    : join(process.cwd(), DEFAULT_DIR);

  const format = process.env.DOWNLOAD_FORMAT?.trim().toUpperCase() === 'TS' ? 'TS' : 'MP4';

  return {
    dir,
    format,
    concurrency: clampInt(process.env.DOWNLOAD_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 8),
    segmentConcurrency: clampInt(
      process.env.DOWNLOAD_SEGMENT_CONCURRENCY,
      DEFAULT_SEGMENT_CONCURRENCY,
      1,
      16
    ),
    maxEpisodesPerBatch: clampInt(
      process.env.DOWNLOAD_MAX_EPISODES,
      DEFAULT_MAX_EPISODES,
      1,
      2000
    ),
    minFreeSpaceBytes: clampInt(
      process.env.DOWNLOAD_MIN_FREE_MB,
      DEFAULT_MIN_FREE_MB,
      0,
      1024 * 1024
    ) * 1024 * 1024,
  };
}

/** 剩余空间低于 1GB 时拒绝开新任务 */
const DEFAULT_MIN_FREE_MB = 1024;

/**
 * 查询下载目录所在磁盘的剩余空间（字节）。
 * 查不到时返回 undefined —— 平台不支持 statfs 时不做限制，
 * 宁可少一道防线，也不要让「查不到空间」变成「一律拒绝下载」。
 */
export async function getFreeSpaceBytes(dir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dir);
    // bavail：非特权用户可用的块数
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
