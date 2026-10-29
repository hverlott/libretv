import { it, expect } from 'vitest';
import { parseMangaProgress } from './manga-progress';
it('tolerates broken and incompatible storage',()=>{for(const raw of ['bad','null','{}','[null,{}, {"page":-1}]']) expect(parseMangaProgress(raw)).toEqual([]);});
it('keeps valid positions and caps storage',()=>{const rows=Array.from({length:120},(_,i)=>({mangaId:String(i),chapterId:'c',page:i,updatedAt:1}));expect(parseMangaProgress(JSON.stringify(rows))).toHaveLength(100);expect(parseMangaProgress(JSON.stringify(rows))[4].page).toBe(4);});
