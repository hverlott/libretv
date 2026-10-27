import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RatingCache } from './cache';

/**
 * 评分缓存单测。
 *
 * 重点是隐私属性：磁盘文件里不能出现明文片名。
 * 内存里保留明文是必要的（进程内要反查），落盘时才换成 HMAC 键。
 */

let dir: string;

function makeCache(opts?: { ttlMs?: number }) {
  return new RatingCache({ dir, ttlMs: opts?.ttlMs ?? 60_000, persist: true });
}

function readDisk(): string {
  const files = fs.readdirSync(dir);
  const target = files.find((f) => f.endsWith('.json'));
  if (!target) return '';
  return fs.readFileSync(path.join(dir, target), 'utf8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-rating-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RatingCache', () => {
  it('命中与未命中都能读写', () => {
    const cache = makeCache();
    cache.set('k1', { provider: 'douban', score: 8.1, votes: 100 });
    cache.set('k2', { provider: null, score: 0, votes: 0 });

    expect(cache.get('k1')).toMatchObject({ provider: 'douban', score: 8.1, votes: 100 });
    expect(cache.get('k2')).toMatchObject({ provider: null, score: 0 });
    expect(cache.get('missing')).toBeUndefined();
  });

  it('落盘后不含明文片名（键是 HMAC）', () => {
    const cache = makeCache();
    cache.set('周处除三害|2023', { provider: 'douban', score: 8.1, votes: 1210072 });
    cache.flush();

    const raw = readDisk();
    expect(raw).not.toContain('周处除三害');
    expect(raw).not.toContain('2023');
    // 评分数值本身是要读回来的，允许出现在文件里
    expect(raw).toContain('8.1');
  });

  it('新实例能从磁盘读回（重启不丢）', () => {
    const first = makeCache();
    first.set('key-a', { provider: 'tmdb', score: 7.2, votes: 42 });
    first.flush();

    const second = makeCache();
    expect(second.get('key-a')).toMatchObject({ provider: 'tmdb', score: 7.2, votes: 42 });
  });

  it('过期条目不再返回', () => {
    const cache = makeCache({ ttlMs: 10 });
    cache.set('old', { provider: 'douban', score: 9, votes: 1 });
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) {
      /* 等过期 */
    }
    expect(cache.get('old')).toBeUndefined();
  });

  it('负缓存可以单独设更短的 TTL', () => {
    const cache = makeCache({ ttlMs: 10_000 });
    cache.set('hit', { provider: 'douban', score: 8, votes: 1 });
    cache.set('miss', { provider: null, score: 0, votes: 0 }, 10);

    expect(cache.get('hit')).not.toBeUndefined();
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) {
      /* 等负缓存过期 */
    }
    expect(cache.get('miss')).toBeUndefined();
    expect(cache.get('hit')).not.toBeUndefined();
  });

  it('磁盘文件损坏时降级为空缓存而不是崩溃', () => {
    fs.writeFileSync(path.join(dir, 'rating-cache.json'), '{ not json');
    const cache = makeCache();
    expect(cache.get('anything')).toBeUndefined();
    expect(() => cache.set('k', { provider: 'douban', score: 1, votes: 1 })).not.toThrow();
  });

  it('条目数超限时淘汰最旧的一批', () => {
    const cache = new RatingCache({ dir, ttlMs: 60_000, persist: false });
    for (let i = 0; i < 10_100; i++) {
      cache.set(`k${i}`, { provider: 'douban', score: 5, votes: 1 });
    }
    expect(cache.size).toBeLessThanOrEqual(10_000);
    // 最新写入的一定还在
    expect(cache.get('k10099')).not.toBeUndefined();
  });

  it('persist=false 时不写磁盘', () => {
    const cache = new RatingCache({ dir, ttlMs: 60_000, persist: false });
    cache.set('k', { provider: 'douban', score: 6, votes: 1 });
    cache.flush();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
