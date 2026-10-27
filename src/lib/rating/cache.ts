/**
 * 评分缓存：内存 + 落盘。
 *
 * ## 为什么落盘的键是哈希
 *
 * 项目隐私原则是「看了什么不出本机」。评分查询的键是片名——把片名明文写在磁盘上，
 * 等于留了一份「本机查过哪些片」的清单。所以落盘只存 HMAC(部署密钥, 查询键)，
 * 与隐私中心用的是同一套密钥派生（PROXY_SECRET / PASSWORD）。
 * 拿到磁盘文件的人无法通过哈希反推片名，除非他已经知道要查什么。
 *
 * 内存里仍保留明文键（进程内需要反查），进程退出即消失。
 */

import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveMasterKey } from '../privacy-crypto-server';

const CACHE_FILE = 'rating-cache.json';
const MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 20_000;

/** provider 落盘编码 */
const PROVIDER_CODE = { tmdb: 't', douban: 'd', none: '-' } as const;
const CODE_PROVIDER = { t: 'tmdb', d: 'douban' } as const;

export interface CachedRating {
  provider: 'tmdb' | 'douban' | null;
  score: number;
  votes: number;
  at: number;
  /** 条目自身有效期（毫秒）：「确认没分」的负缓存要比命中缓存短得多 */
  ttl?: number;
}

type DiskTuple = [string, number, number, number, number];

interface DiskFile {
  v: 1;
  entries: Record<string, DiskTuple>;
}

/** HKDF 很便宜，但每次查缓存都派生一遍纯属浪费：密钥在进程内不变，算一次就够 */
let masterKey: Buffer | undefined | null = null;

function secretKey(): Buffer | undefined {
  if (masterKey !== null) return masterKey ?? undefined;
  const secret = process.env.PROXY_SECRET || process.env.PASSWORD;
  masterKey = secret ? deriveMasterKey(secret) : undefined;
  return masterKey ?? undefined;
}

export class RatingCache {
  private readonly memory = new Map<string, CachedRating>();
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly persist: boolean;
  private loaded = false;
  private dirty = 0;
  private lastFlush = 0;

  constructor(opts: { dir?: string; ttlMs?: number; persist?: boolean } = {}) {
    const dir = opts.dir
      ? path.resolve(opts.dir)
      : path.join(process.cwd(), '.runtime', 'rating-cache');
    this.file = path.join(dir, CACHE_FILE);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.persist = opts.persist ?? true;
  }

  /**
   * 条目键 → 存储键。
   *
   * 内存里也用哈希后的键：这样连进程内的缓存 Map 都不含明文片名，
   * 只有真正持有查询输入的代码路径才碰得到原文。
   */
  private hashKey(key: string): string {
    const master = secretKey();
    if (master) {
      return createHmac('sha256', master).update(key).digest('hex').slice(0, 32);
    }
    return createHmac('sha256', 'libretv-rating').update(key).digest('hex').slice(0, 32);
  }

  private ensureLoaded(): void {
    if (this.loaded || !this.persist) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as DiskFile;
      const entries = parsed?.entries ?? {};
      const now = Date.now();
      for (const [hash, tuple] of Object.entries(entries)) {
        if (!Array.isArray(tuple) || tuple.length < 4) continue;
        const [code, score, votes, at, ttl] = tuple;
        if (now - at > (ttl || this.ttlMs)) continue;
        // ttl=0 表示「沿用默认」，不要把它当成真值存进去
        const entry: CachedRating = {
          provider: code === '-' ? null : CODE_PROVIDER[code as keyof typeof CODE_PROVIDER] ?? null,
          score,
          votes,
          at,
        };
        if (ttl > 0) entry.ttl = ttl;
        this.memory.set(hash, entry);
      }
    } catch {
      // 首次启动 / 文件损坏：当作空缓存，不影响功能
    }
  }

  get(key: string): CachedRating | undefined {
    this.ensureLoaded();
    const hash = this.hashKey(key);
    const hit = this.memory.get(hash);
    if (!hit) return undefined;
    if (Date.now() - hit.at > (hit.ttl || this.ttlMs)) {
      this.memory.delete(hash);
      return undefined;
    }
    return hit;
  }

  set(key: string, value: Omit<CachedRating, 'at'>, ttl?: number): void {
    this.ensureLoaded();
    const entry: CachedRating = { ...value, at: Date.now() };
    if (ttl && ttl > 0) entry.ttl = ttl;
    this.memory.set(this.hashKey(key), entry);

    if (this.memory.size > MAX_ENTRIES) {
      // 淘汰最旧的一批（评分不会频繁变化，丢旧的总比无上限增长好）
      const sorted = [...this.memory.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of sorted.slice(0, Math.ceil(MAX_ENTRIES * 0.1))) this.memory.delete(k);
    }
    this.dirty++;
    this.maybeFlush();
  }

  /** 把内存里的键映射落到磁盘（键经 HMAC，值只剩评分数值） */
  private maybeFlush(): void {
    if (!this.persist || this.dirty === 0) return;
    const now = Date.now();
    if (now - this.lastFlush < FLUSH_INTERVAL_MS) return;
    this.flush();
  }

  flush(): void {
    if (!this.persist) return;
    this.lastFlush = Date.now();
    this.dirty = 0;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const entries: Record<string, DiskTuple> = {};
      for (const [key, value] of this.memory) {
        // memory 的键已经是哈希值，落盘时无需再算一次
        entries[key] = [
          value.provider ? PROVIDER_CODE[value.provider] : '-',
          value.score,
          value.votes,
          value.at,
          value.ttl ?? 0,
        ];
      }
      const payload: DiskFile = { v: 1, entries };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.file);
    } catch {
      // 磁盘不可写时静默降级为纯内存缓存
    }
  }

  get size(): number {
    this.ensureLoaded();
    return this.memory.size;
  }

  /** 测试用：清空内存与磁盘 */
  clear(): void {
    this.memory.clear();
    this.loaded = true;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}
