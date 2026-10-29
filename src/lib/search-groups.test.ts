import { describe, it, expect } from 'vitest';
import { aggregateResults } from './search-groups';
import type { SearchResultItem } from './types';
const item = (id: string, extra: Partial<SearchResultItem> = {}): SearchResultItem => ({sourceKey:id, sourceName:id, vodId:'1', name:'测试作品', year:'2024', typeName:'剧情片', ...extra});
describe('search grouping', () => {
 it('merges typography variants and deduplicates identical entries', () => {const a=item('a');expect(aggregateResults([a,a,item('b',{name:'测试 作品！'})])[0].items).toHaveLength(2);});
 it('keeps remakes, series and films separate', () => expect(aggregateResults([item('a'),item('b',{year:'2020'}),item('c',{typeName:'国产剧'})])).toHaveLength(3));
 it('does not guess years when multiple remakes exist', () => expect(aggregateResults([item('a'),item('b',{year:'2020'}),item('c',{year:undefined})])).toHaveLength(3));
 it('retains stable keys as another source arrives', () => expect(aggregateResults([item('a')])[0].key).toBe(aggregateResults([item('a'),item('b')])[0].key));
 it('keeps season numbers distinct', () => expect(aggregateResults([item('a',{name:'作品1'}),item('b',{name:'作品2'})])).toHaveLength(2));
});
