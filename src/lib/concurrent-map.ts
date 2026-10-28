/** Run a bounded worker queue; slow tasks do not hold up the next batch.
 * Results retain input order and individual failures use the caller's fallback.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  fallback?: (item: T, index: number, reason: unknown) => R
): Promise<R[]> {
  const size = Number.isFinite(limit) ? Math.max(1, Math.floor(limit) || 1) : 1;
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); }
      catch (reason) { if (fallback) results[index] = fallback(items[index], index, reason); }
    }
  }));
  return results;
}
