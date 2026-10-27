/**
 * 上游限流器（并发 + 最小间隔 + 滑动窗口 + 惩罚冷却）。
 *
 * ## 为什么需要
 *
 * 豆瓣移动端接口反爬极严：实测以 150ms 间隔连打 20 次即被封 IP（403），
 * 恢复要几十分钟到数小时。TMDB 官方给到约 50 次/秒，不需要这么保守。
 * 所以限流参数按 provider 分别配置，而不是全站共用一把尺子。
 *
 * 被封（403/429）时调用 penalize()，进入冷却期，期间请求直接返回缓存，
 * 不再往上游打——否则会在已经 403 的情况下继续撞墙，延长封禁时间。
 */

import { createHash } from 'node:crypto';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 令牌直接交接的信号量：release 时把名额递给等待者，避免抢占导致超额 */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // 名额已由 release 直接交接，这里不再自增
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}

export interface ThrottleOptions {
  /** 最大并发 */
  concurrency: number;
  /** 两次请求之间的最小间隔（毫秒） */
  minIntervalMs: number;
  /** 滑动窗口内允许的最大请求数 */
  maxPerWindow: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

export class Throttle {
  private readonly sem: Semaphore;
  private readonly hits: number[] = [];
  private last = 0;
  private cooldownUntil = 0;
  private penaltyCount = 0;

  constructor(private readonly opts: ThrottleOptions) {
    this.sem = new Semaphore(Math.max(1, opts.concurrency));
  }

  /** 在上游请求外层套上限流；fn 抛错由调用方处理 */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.sem.acquire();
    try {
      await this.waitForSlot();
      return await fn();
    } finally {
      this.sem.release();
    }
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.hits.length > 0 && this.hits[0] + this.opts.windowMs <= now) this.hits.shift();

      let wait = 0;
      if (this.cooldownUntil > now) wait = Math.max(wait, this.cooldownUntil - now);
      if (this.opts.minIntervalMs > 0 && this.last > 0) {
        wait = Math.max(wait, this.last + this.opts.minIntervalMs - now);
      }
      if (this.hits.length >= this.opts.maxPerWindow) {
        wait = Math.max(wait, this.hits[0] + this.opts.windowMs - now);
      }
      if (wait <= 0) break;
      await sleep(wait + 1);
    }
    const stamp = Date.now();
    this.last = stamp;
    this.hits.push(stamp);
  }

  /**
   * 被上游拒绝后冷却：连续被拒则指数退避（1min → 2min → 5min，上限 10min）。
   */
  penalize(): void {
    this.penaltyCount++;
    const minutes = Math.min(10, 2 ** (this.penaltyCount - 1));
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + minutes * 60_000);
  }

  /** 请求成功后清除退避计数 */
  clearPenalty(): void {
    this.penaltyCount = 0;
  }

  get coolingDown(): boolean {
    return this.cooldownUntil > Date.now();
  }

  get pending(): number {
    return this.sem.waiting;
  }

  get inFlight(): number {
    return this.sem.inFlight;
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }
}

/** 稳定哈希：用于把长标题压成固定长度的键 */
export function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
