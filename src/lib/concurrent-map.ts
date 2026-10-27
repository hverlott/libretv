/**
 * 有限并发执行（Promise.all 的分批替代）。
 *
 * ## 为什么不用 `Promise.all(items.map(fn))`
 *
 * 那会让**全部**任务同时发起。对于出网请求（本项目的搜索 / 详情 / 测活场景），
 * 这意味着几十个 TLS 握手一起打出去，会耗尽本机并发连接与文件描述符。
 * 表现出来的问题很有迷惑性：
 *
 * - 单个源**单独**测试完全正常（HTTP 200、正常返回条目）；
 * - 混在一批几十个源里一起搜，就 `fetch failed` / 连接重置。
 *
 * 也就是说弱源被同批的其他源**连累**了，但它自身没有任何问题。
 *
 * 分批执行既保住了整体吞吐（38 个源、每批 6 个 ≈ 7 批），
 * 又让每个任务有独立的连接资源。
 *
 * ## 顺序保证
 *
 * 结果数组按输入下标回填，因此 `mapWithConcurrency` 与 `Promise.all`
 * 一样保持顺序——调用方若依赖「结果下标 === 输入下标」（搜索聚合就依赖，
 * 用来把 outcome 回填到 `outcomes[i]`）可以直接替换。
 *
 * ## 异常处理
 *
 * 用 `Promise.allSettled`：单个任务 reject 不会中断整批。
 * 调用方通过 `fallback` 决定 reject 时填什么（本项目的搜索填
 * 「该源失败」的 outcome，让 UI 显示哪个源坏了而不是整次搜索崩掉）。
 */

/** 任务失败时的兜底值；省略时该位置留 undefined */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  fallback?: (item: T, index: number, reason: unknown) => R
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);

  for (let start = 0; start < items.length; start += size) {
    const indices: number[] = [];
    for (let i = start; i < Math.min(start + size, items.length); i += 1) indices.push(i);

    const settled = await Promise.allSettled(indices.map((index) => fn(items[index], index)));

    settled.forEach((outcome, offset) => {
      const index = indices[offset];
      if (outcome.status === 'fulfilled') {
        results[index] = outcome.value;
        return;
      }
      if (fallback) results[index] = fallback(items[index], index, outcome.reason);
    });
  }

  return results;
}