import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrent-map';

describe('mapWithConcurrency（有限并发）', () => {
  it('结果按输入顺序回填', async () => {
    const items = [30, 5, 20, 1, 15];
    const out = await mapWithConcurrency(items, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:15']);
  });

  it('并发数不超过 limit（本模块存在的核心目的）', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('单个任务 reject 不影响其他任务（用 fallback 兜底）', async () => {
    const out = await mapWithConcurrency(
      [1, 2, 3],
      2,
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n * 10;
      },
      (item, _i, reason) => -1 * ((reason as Error).message === 'boom' ? 1 : 0)
    );
    // 1 与 3 正常，2 被 fallback 填 -1
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(-1);
    expect(out[2]).toBe(30);
  });

  it('无 fallback 时失败位置留 undefined，且不抛', async () => {
    const out = await mapWithConcurrency(
      [1, 2],
      2,
      async (n) => {
        if (n === 1) throw new Error('x');
        return n;
      }
    );
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBe(2);
  });

  it('空数组与 limit<=1 都能安全处理', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
    const one = await mapWithConcurrency([1, 2, 3], 1, async (n) => n + 1);
    expect(one).toEqual([2, 3, 4]);
    const zero = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(zero).toEqual([1, 2]);
  });

  it('任务数少于 limit 时不额外等待', async () => {
    const t0 = Date.now();
    await mapWithConcurrency([1, 2], 10, async () => 'ok');
    expect(Date.now() - t0).toBeLessThan(200);
  });
});