/**
 * 服务端整集下载引擎（Node 运行时）。
 *
 * 为什么放服务端而不是浏览器端：
 * - 浏览器端每集都要弹一次「另存为」，多选批量下载会变成弹窗地狱；
 * - 浏览器端依赖 Cache Storage 断点，受浏览器存储配额限制，大批量不可靠；
 * - 服务端直接写磁盘（本机部署即本机磁盘），选一次目录即可完成多集。
 *
 * 能力：
 * - master 播放列表递归选档（默认最高码率），media 列表取分片；
 * - AES-128-CBC 解密（HLS 标准，IV 缺省时用媒体序列号大端 16 字节）；
 * - TS 直接顺序拼接，或经 mux.js 转封装为 fMP4（复用浏览器端同一实现，产物一致）；
 * - 分片并发下载（默认 8），单分片重试，4xx 视为确定性缺失不重试；
 * - 边下边写（不把整集聚合在内存里），进度实时上报。
 *
 * 关键约束：mux.js 的 Transmuxer 是有状态的状态机，push 必须严格按分片顺序、
 * 且不可并发。因此本模块把「并发下载」与「顺序装配」拆成两段：
 * worker 负责并发取分片，OrderedSink 负责按索引排队后顺序喂给转封装器。
 */

import { createDecipheriv } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StreamingTransmuxer } from './mp4-transmuxer';

// —— 类型 ——

export interface DownloadSegment {
  url: string;
  duration: number;
}

export interface AesKeyInfo {
  /** 密钥的绝对地址 */
  uri: string;
  /** 清单里显式给的 IV（hex，无 0x 前缀）；缺省用媒体序列号推导 */
  iv?: string;
}

export interface ParsedMediaPlaylist {
  segments: DownloadSegment[];
  aes?: AesKeyInfo;
  /** 媒体序列号（用于推导缺省 IV） */
  mediaSequence: number;
  /** 整集时长（秒） */
  totalDuration: number;
  /** 清单里最高档的分辨率（选档时记录） */
  variantHeight?: number;
}

export type ServerDownloadErrorCode =
  | 'parse-failed'
  | 'key-failed'
  | 'segment-missing'
  | 'segment-failed'
  | 'byrange-unsupported'
  | 'aborted'
  | 'write-failed';

export class ServerDownloadError extends Error {
  constructor(
    message: string,
    readonly code: ServerDownloadErrorCode,
    /** 原始错误堆栈（转封装等内部环节的定位依据） */
    readonly cause?: string
  ) {
    super(message);
    this.name = 'ServerDownloadError';
  }
}

export interface ServerDownloadOptions {
  /** m3u8 地址（直连上游） */
  url: string;
  /** 目标文件绝对路径 */
  outputPath: string;
  format: 'TS' | 'MP4';
  /** 分片并发数 */
  concurrency?: number;
  /** 单分片超时（毫秒） */
  segmentTimeoutMs?: number;
  /** 单分片重试次数 */
  retries?: number;
  signal?: AbortSignal;
  /** 进度回调 */
  onProgress?: (p: { finished: number; total: number; bytes: number }) => void;
  /** 请求头附加项（如 Referer） */
  headers?: Record<string, string>;
}

export interface ServerDownloadResult {
  filePath: string;
  bytes: number;
  segments: number;
  elapsedMs: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEGMENT_TIMEOUT_MS = 20_000;
const MAX_SEGMENT_RETRIES = 3;
const MAX_PLAYLIST_DEPTH = 4;

// —— 播放列表解析 ——

function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * 拉取并解析 m3u8：master 递归选档，media 解析分片。
 * 选档取最高带宽——下载场景要的是完整画质，不是自适应码率的实时最优。
 */
export async function parseMediaPlaylist(
  url: string,
  options: { headers?: Record<string, string>; depth?: number; signal?: AbortSignal } = {}
): Promise<ParsedMediaPlaylist> {
  const depth = options.depth ?? 0;
  if (depth > MAX_PLAYLIST_DEPTH) {
    throw new ServerDownloadError('播放列表嵌套过深', 'parse-failed');
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...(options.headers ?? {}) },
    signal: options.signal,
  });
  if (!res.ok) {
    throw new ServerDownloadError(`播放列表拉取失败：HTTP ${res.status}`, 'parse-failed');
  }
  const text = await res.text();
  const lines = text.split('\n').map((l) => l.trim());

  // —— master：收集变体，选最高码率后递归 ——
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants: { url: string; bandwidth: number; height?: number }[] = [];
    let pending: { bandwidth: number; height?: number } | undefined;
    for (const raw of lines) {
      if (raw.startsWith('#EXT-X-STREAM-INF')) {
        const resMatch = raw.match(/RESOLUTION=(\d+)x(\d+)/);
        pending = {
          bandwidth: parseInt(raw.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10),
          height: resMatch ? parseInt(resMatch[2], 10) : undefined,
        };
        continue;
      }
      if (!raw || raw.startsWith('#')) continue;
      if (pending) {
        variants.push({ url: absolutize(raw, url), ...pending });
        pending = undefined;
      }
    }
    if (variants.length === 0) {
      throw new ServerDownloadError('播放列表未解析到可用档位', 'parse-failed');
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const chosen = variants[0];
    const inner = await parseMediaPlaylist(chosen.url, {
      headers: options.headers,
      depth: depth + 1,
      signal: options.signal,
    });
    return { ...inner, variantHeight: chosen.height };
  }

  // —— media：分片 / 时长 / AES ——
  const segments: DownloadSegment[] = [];
  let aes: AesKeyInfo | undefined;
  let pendingDuration = 0;
  let pendingByteRange = false;
  const mediaSequence = parseInt(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || '0', 10) || 0;

  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith('#EXT-X-KEY')) {
      // METHOD 的取值含连字符（AES-128），字符类必须含 '-'，
      // 否则 \w+ 只匹配到 "AES"，会被误判成不支持的加密方式
      const method = raw.match(/METHOD=([A-Za-z0-9-]+)/)?.[1] || 'NONE';
      if (method === 'NONE') {
        aes = undefined;
      } else if (method === 'AES-128') {
        const uri = raw.match(/URI="([^"]+)"/)?.[1];
        if (!uri) {
          throw new ServerDownloadError('加密清单缺少密钥地址', 'parse-failed');
        }
        aes = {
          uri: absolutize(uri, url),
          iv: raw.match(/IV=0x([0-9a-fA-F]+)/)?.[1]?.toLowerCase(),
        };
      } else {
        throw new ServerDownloadError(`不支持的加密方式：${method}`, 'parse-failed');
      }
      continue;
    }
    if (raw.startsWith('#EXT-X-BYTERANGE')) {
      pendingByteRange = true;
      continue;
    }
    if (raw.startsWith('#EXTINF')) {
      pendingDuration = parseFloat(raw.match(/EXTINF:([\d.]+)/)?.[1] || '0') || 0;
      continue;
    }
    if (raw.startsWith('#')) continue;

    if (pendingByteRange) {
      throw new ServerDownloadError('该视频使用 BYTERANGE 分片，暂不支持下载', 'byrange-unsupported');
    }
    segments.push({ url: absolutize(raw, url), duration: pendingDuration });
    pendingDuration = 0;
  }

  if (segments.length === 0) {
    throw new ServerDownloadError('播放列表中没有分片', 'parse-failed');
  }

  return {
    segments,
    aes,
    mediaSequence,
    totalDuration: segments.reduce((sum, s) => sum + s.duration, 0),
  };
}

// —— 分片获取 ——

/** 缺省 IV：媒体序列号（16 字节大端），逐分片递增（RFC 8216 §4.3.2.4） */
function ivFromSequence(mediaSequence: number, zeroBasedIndex: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE((mediaSequence + zeroBasedIndex) >>> 0, 12);
  return iv;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  headers: Record<string, string>
): Promise<Buffer> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(url, { headers, signal: combined });
  if (!res.ok) {
    // 5xx / 408 / 429 是抖动，值得重试；其余 4xx 是源站确定性缺失
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new ServerDownloadError(
      `HTTP ${res.status}`,
      retryable ? 'segment-failed' : 'segment-missing'
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchSegment(
  url: string,
  index: number,
  timeoutMs: number,
  retries: number,
  signal: AbortSignal | undefined,
  headers: Record<string, string>
): Promise<Buffer> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal?.aborted) throw new ServerDownloadError('已取消', 'aborted');
    try {
      return await fetchWithTimeout(url, timeoutMs, signal, headers);
    } catch (err) {
      if (signal?.aborted) throw new ServerDownloadError('已取消', 'aborted');
      if (err instanceof ServerDownloadError && err.code === 'segment-missing') {
        throw new ServerDownloadError(
          `分片 ${index} 在源站不存在（${err.message}），该来源无法完整下载，建议更换来源`,
          'segment-missing'
        );
      }
      if (attempt === retries - 1) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new ServerDownloadError(`分片 ${index} 下载失败（已重试 ${retries} 次）`, 'segment-failed');
}

// —— 顺序装配 ——

/**
 * 按索引顺序执行写入动作。
 *
 * 每个索引有独立的链：第 i 项要等第 i-1 项完成后才开始，
 * 因此无论 worker 以什么顺序完成，落盘/转封装的顺序始终是分片顺序。
 * 这对 mux.js 是硬要求——它的 Transmuxer 是有状态机，并发 push 会产出损坏文件。
 */
class OrderedSink {
  private chains: Promise<void>[] = [];
  private failure: Error | undefined;

  async run(index: number, fn: () => Promise<void> | void): Promise<void> {
    const prev = this.chains[index] ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 本索引的链 = 前序链 → 本次完成信号
    this.chains[index] = prev.then(() => current);
    await prev;
    if (this.failure) throw this.failure;
    try {
      await fn();
    } catch (err) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      throw this.failure;
    } finally {
      release();
    }
  }

  /** 等待所有已登记的索引完成 */
  async drain(): Promise<void> {
    await Promise.all(this.chains);
    if (this.failure) throw this.failure;
  }
}

// —— 文件写入 ——

/** 带背压处理的顺序写入器 */
class FileSink {
  private chain: Promise<void> = Promise.resolve();
  private error: Error | undefined;
  bytesWritten = 0;

  constructor(private readonly stream: WriteStream) {}

  write(data: Buffer): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.error) throw this.error;
      this.bytesWritten += data.length;
      if (!this.stream.write(data)) {
        await new Promise<void>((resolve) => this.stream.once('drain', () => resolve()));
      }
    });
    this.chain.catch((err) => {
      this.error = err instanceof Error ? err : new Error(String(err));
    });
    return this.chain;
  }

  async close(): Promise<void> {
    await this.chain;
    if (this.error) throw this.error;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  abort(): void {
    this.stream.destroy();
  }
}

// —— 主流程 ——

/**
 * 下载一整集到磁盘。
 *
 * 写盘策略：先写 `.part` 临时文件，成功后 rename 到最终名——
 * 中断时不会留下「看起来完整其实缺片」的文件。
 */
export async function downloadEpisodeToFile(
  options: ServerDownloadOptions
): Promise<ServerDownloadResult> {
  const {
    url,
    outputPath,
    format,
    concurrency = 8,
    segmentTimeoutMs = SEGMENT_TIMEOUT_MS,
    retries = MAX_SEGMENT_RETRIES,
    signal,
    onProgress,
    headers = {},
  } = options;

  const startedAt = Date.now();
  const requestHeaders = { 'User-Agent': DEFAULT_UA, ...headers };

  const playlist = await parseMediaPlaylist(url, { headers: requestHeaders, signal });

  // —— 密钥预取 ——
  let aesKey: Buffer | undefined;
  if (playlist.aes) {
    try {
      const keyRes = await fetch(playlist.aes.uri, { headers: requestHeaders, signal });
      if (!keyRes.ok) {
        throw new ServerDownloadError(`解密密钥加载失败：HTTP ${keyRes.status}`, 'key-failed');
      }
      aesKey = Buffer.from(await keyRes.arrayBuffer());
    } catch (err) {
      if (err instanceof ServerDownloadError) throw err;
      throw new ServerDownloadError(
        `解密密钥加载失败：${err instanceof Error ? err.message : String(err)}`,
        'key-failed'
      );
    }
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const partPath = `${outputPath}.part`;
  // 上一轮残留的半成品先清掉，避免拼进旧数据
  await rm(partPath, { force: true }).catch(() => {});

  const stream = createWriteStream(partPath);
  const fileSink = new FileSink(stream);
  const sink = new OrderedSink();
  const total = playlist.segments.length;
  let finishedSegments = 0;
  let bytesReported = 0;

  // MP4 走转封装器；TS 直接落盘。两者都通过 OrderedSink 保证顺序。
  const transmuxer =
    format === 'MP4'
      ? new StreamingTransmuxer(
          { write: async (data: Uint8Array) => fileSink.write(Buffer.from(data)) },
          { durationSeconds: playlist.totalDuration }
        )
      : undefined;

  const reportProgress = () => {
    onProgress?.({ finished: finishedSegments, total, bytes: bytesReported });
  };

  /** 并发拉取分片；装配动作交给 OrderedSink 排队，保证严格顺序 */
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new ServerDownloadError('已取消', 'aborted');
      const index = cursor++;
      if (index >= total) return;
      const raw = await fetchSegment(
        playlist.segments[index].url,
        index + 1,
        segmentTimeoutMs,
        retries,
        signal,
        requestHeaders
      );
      let data = raw;
      if (aesKey && playlist.aes) {
        const iv = playlist.aes.iv
          ? Buffer.from(playlist.aes.iv, 'hex')
          : ivFromSequence(playlist.mediaSequence, index);
        try {
          const decipher = createDecipheriv('aes-128-cbc', aesKey, iv);
          data = Buffer.concat([decipher.update(raw), decipher.final()]);
        } catch (err) {
          throw new ServerDownloadError(
            `分片 ${index + 1} 解密失败：${err instanceof Error ? err.message : String(err)}`,
            'segment-failed'
          );
        }
      }
      // 队列按索引排序后装配——这一步是串行的，转封装器因此不会被打乱
      await sink.run(index, async () => {
        if (transmuxer) {
          await transmuxer.pushAndTransmux(new Uint8Array(data));
        } else {
          await fileSink.write(data);
        }
        finishedSegments += 1;
        bytesReported = fileSink.bytesWritten;
        reportProgress();
      });
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(Math.max(concurrency, 1), 16) }, () => worker())
    );
    await sink.drain();
    if (transmuxer) await transmuxer.finish();
    await fileSink.close();
  } catch (err) {
    fileSink.abort();
    await rm(partPath, { force: true }).catch(() => {});
    if (err instanceof ServerDownloadError) throw err;
    // 保留原始堆栈：转封装内部的错误信息（如 mux.js 的 "reading 'video'"）
    // 单独看完全无法定位，必须带着栈才知道是哪个环节
    throw new ServerDownloadError(
      `下载失败：${err instanceof Error ? err.message : String(err)}`,
      'write-failed',
      err instanceof Error ? err.stack : undefined
    );
  }

  await rename(partPath, outputPath);
  const finalStat = await stat(outputPath).catch(() => null);

  return {
    filePath: outputPath,
    bytes: finalStat?.size ?? fileSink.bytesWritten,
    segments: total,
    elapsedMs: Date.now() - startedAt,
  };
}

// —— 文件名 ——

/** 拼出输出文件路径 */
export function buildOutputFilePath(dir: string, title: string, extension: string): string {
  return join(dir, `${sanitizeFileName(title)}.${extension}`);
}

/**
 * 文件名净化：去掉路径分隔符与控制字符，压缩空白，限长。
 * 保留中日韩字符——片名基本都是中文，砍掉就没法看了。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 保留名
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1');
  const trimmed = cleaned.slice(0, 120).trim();
  return trimmed || '未命名';
}
