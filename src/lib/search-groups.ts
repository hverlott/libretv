import type { SearchResultItem } from './types';
import { classify } from './browse-parser';
import { inferGroupRemarks } from './remarks';
export const normalizeGroupTitle = (title: string) => title.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・:：!！?？,，。]/g, '').trim();

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: JSON.stringify([normalizeGroupTitle(name), year ?? '', classify(items[0]?.typeName), Boolean(items[0]?.isAdult)]),
    name,
    year,
    typeName: items.find((i) => i.typeName)?.typeName,
    pic: items.find((i) => i.pic)?.pic,
    // 同一部剧各源文案详略不同（「全34集」/「完结」/「更新至34集」），推到统一结论，
    // 否则同一部剧的来源列表会看起来状态各异
    remarks: inferGroupRemarks(items.map((i) => i.remarks)),
    items,
  };
}

/**
 * 把扁平的跨源搜索结果按「同名影片」聚合：
 * - 按规范化标题与类型分桶；多年份时拆分，缺失年份保持独立；
 * - 保持传入顺序（搜索结果已按名称排序）。
 */
export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const seen = new Set<string>();
  const byName = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const title = normalizeGroupTitle(item.name || '');
    const k = title ? JSON.stringify([title, classify(item.typeName), Boolean(item.isAdult)]) : '';
    if (seen.has(`${item.sourceKey}:${item.vodId}`)) continue;
    seen.add(`${item.sourceKey}:${item.vodId}`);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(item);
  }
  const groups: AggregatedGroup[] = [];
  for (const items of byName.values()) {
    const name = items[0].name.trim();
    const years = [...new Set(items.map((i) => i.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const y of years) {
        groups.push(buildGroup(name, y, items.filter((i) => i.year === y)));
      }
      const noYear = items.filter((i) => !i.year);
      if (noYear.length) groups.push(buildGroup(name, undefined, noYear));
    } else {
      groups.push(buildGroup(name, years[0], items));
    }
  }
  return groups;
}

