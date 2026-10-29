import type { SourceConfig } from './types';
import type { SourceHealthEntry } from './store';
export function prioritizeSources(sources: SourceConfig[], health: Record<string, SourceHealthEntry>, now = Date.now()): SourceConfig[] {
  const score = (key: string) => {
    const h = health[key];
    if (!h || now - h.timestamp > 7 * 86400000) return 0;
    const samples = h.samples ?? [h.ok];
    const reliability = (samples.filter(Boolean).length + 1) / (samples.length + 2);
    return reliability * 100 - Math.min(30, (h.averageMs ?? h.ms ?? 3000) / 1000) - h.failStreak * 10;
  };
  return [...sources].sort((a, b) => score(b.key) - score(a.key));
}
