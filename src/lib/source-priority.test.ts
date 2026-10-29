import { it, expect } from 'vitest';
import { prioritizeSources } from './source-priority';
const sources = ['slow','fast','new'].map(key=>({key,name:key,url:'https://example.com'}));
it('prioritizes recent reliable fast sources without mutating selection',()=>{
 const h={ok:true,failStreak:0,timestamp:1000,samples:[true,true]};
 expect(prioritizeSources(sources,{slow:{...h,averageMs:9000},fast:{...h,averageMs:1000}},2000).map(s=>s.key)).toEqual(['fast','slow','new']);
 expect(sources[0].key).toBe('slow');
});
it('ignores stale observations',()=>expect(prioritizeSources(sources,{fast:{ok:true,failStreak:0,timestamp:1}},8*86400000)).toEqual(sources));
