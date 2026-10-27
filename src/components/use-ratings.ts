'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiError, api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import type { RatingInfo } from '@/lib/types';

/**
 * 评分补全的客户端调度。
 *
 * ## 为什么要单独一个全局队列
 *
 * 每张卡片各发一个请求 = 40 个并发请求打到豆瓣，实测 20 次就足以让 IP 被封。
 * 这里做三层收敛，和 use-quality-probe 的思路一致：
 * - **攒批**：卡片挂载时只是入队，攒够一批（12 条）才真正发出；
 * - **串行**：同一时刻只有一批在飞，批间留 1.2s 间隔；
 * - **预算**：60 秒窗口内最多问 12 条。超预算的条目留在队列里等下一个窗口，
 *   由于服务端有 30 天磁盘缓存，第二次访问几乎全部命中缓存、一个请求都不用发。
 *
 * 结果是：首屏十几条能拿到分，剩下的下次打开就是免费的。
 */

export interface RatingTarget {
  title: string;
  year?: string;
  typeName?: string;
  adult?: boolean;
}

/** 缓存键：标题 + 年份。同名不同年的作品是不同条目（翻拍/续作常见） */
export function ratingKey(target: RatingTarget): string {
  return `${target.title}|${target.year ?? ''}`;
}

const BATCH_SIZE = 12;
const BATCH_GAP_MS = 1200;
const BUDGET = 12;
const BUDGET_WINDOW_MS = 60_000;
const BUDGET_RETRY_MS = 15_000;

const results = new Map<string, RatingInfo | null>();
const listeners = new Set<() => void>();
const queued = new Set<string>();
const queue: RatingTarget[] = [];
let inFlight = false;
let lastBatchAt = 0;
/** 已消耗的预算时间戳（滑动窗口） */
const spent: number[] = [];
let budgetTimer: ReturnType<typeof setTimeout> | null = null;
/** 401/503 时暂停：登录框已弹出，继续发只会白撞 */
let pausedUntil = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spendBudget(n: number): number {
  const now = Date.now();
  while (spent.length > 0 && spent[0] + BUDGET_WINDOW_MS <= now) spent.shift();
  const room = Math.max(0, BUDGET - spent.length);
  const take = Math.min(room, n);
  for (let i = 0; i < take; i++) spent.push(now);
  return take;
}

async function pump(): Promise<void> {
  if (inFlight) return;

  if (queue.length === 0) return;
  if (Date.now() < pausedUntil) {
    scheduleLater(BUDGET_RETRY_MS);
    return;
  }

  const wait = BATCH_GAP_MS - (Date.now() - lastBatchAt);
  if (wait > 0) await sleep(wait);
  if (inFlight) return;

  let batch = queue.splice(0, BATCH_SIZE);
  const allowed = spendBudget(batch.length);
  if (allowed < batch.length) {
    // 超出预算的部分放回队首，等下一个 60s 窗口
    queue.unshift(...batch.slice(allowed));
    batch = batch.slice(0, allowed);
  }
  if (batch.length === 0) {
    queue.unshift(...batch);
    scheduleLater(BUDGET_RETRY_MS);
    return;
  }

  inFlight = true;
  lastBatchAt = Date.now();
  const keys = batch.map(ratingKey);
  try {
    const res = await api.ratingBatch(
      batch.map((t) => ({ title: t.title, year: t.year, typeName: t.typeName, adult: t.adult }))
    );
    batch.forEach((target, index) => {
      results.set(ratingKey(target), res.ratings[index] ?? null);
    });
    notify();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 503)) {
      pausedUntil = Date.now() + 60_000;
    }
    // 失败不写结果：保持「未知」状态，之后可以再试
  } finally {
    for (const key of keys) queued.delete(key);
    inFlight = false;
    if (queue.length > 0) void pump();
  }
}

function scheduleLater(ms: number): void {
  if (budgetTimer) return;
  budgetTimer = setTimeout(() => {
    budgetTimer = null;
    void pump();
  }, ms);
}

/** 入队：去重后交给全局队列 */
export function enqueueRatings(targets: RatingTarget[]): void {
  const fresh = targets.filter((target) => {
    if (!target.title) return false;
    const key = ratingKey(target);
    if (results.has(key) || queued.has(key)) return false;
    queued.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  queue.push(...fresh);
  void pump();
}

/** 供外部注入已解析的评分（如服务端已经下发过） */
export function setRating(target: RatingTarget, info: RatingInfo | null): void {
  results.set(ratingKey(target), info);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 单张卡片的评分状态。
 * - `undefined`：还没查（未知）；
 * - `null`：查过但没有可用评分；
 * - `RatingInfo`：拿到了。
 */
export function useRating(target: RatingTarget | undefined): RatingInfo | null | undefined {
  const key = target ? ratingKey(target) : '';
  const snapshot = useCallback(
    () => (key ? results.get(key) : undefined),
    [key]
  );
  return useSyncExternalStore(subscribe, snapshot, () => undefined);
}

/** 卡片进入视口后再请求：滚过不停留的卡片不会浪费预算 */
export function useRatingAutoFill(enabled: boolean, targets: RatingTarget[]): void {
  // 全局开关：关掉后一个请求都不发（片名不再交给任何第三方）
  const autoFill = useAppStore((s) => s.ratingAutoFill);
  const keys = targets.map(ratingKey).join('\u0000');
  useEffect(() => {
    if (!autoFill || !enabled || targets.length === 0) return;
    enqueueRatings(targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFill, enabled, keys]);
}

/** 详情页单条即时拉取 */
export async function fetchRating(target: RatingTarget): Promise<RatingInfo | null> {
  if (!useAppStore.getState().ratingAutoFill) return null;
  try {
    const res = await api.rating(target.title, { year: target.year, typeName: target.typeName });
    const info = res.rating ?? null;
    results.set(ratingKey(target), info);
    notify();
    return info;
  } catch {
    return null;
  }
}
