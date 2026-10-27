import { describe, expect, it } from 'vitest';
import {
  groupTags,
  isAdultRating,
  pageImageUrl,
  ratingsFor,
  type MangaTag,
} from './mangadex';

describe('MangaDex 客户端工具', () => {
  describe('分级白名单', () => {
    it('默认只返回 safe 与 suggestive', () => {
      expect(ratingsFor(false)).toEqual(['safe', 'suggestive']);
    });

    it('含成人向时放开到 erotica，且止步于此', () => {
      const ratings = ratingsFor(true);
      expect(ratings).toContain('erotica');
      expect(ratings).not.toContain('pornographic');
    });

    it('限制级档位向下累积：pornographic 包含前两档', () => {
      expect(ratingsFor('pornographic')).toEqual([
        'safe',
        'suggestive',
        'erotica',
        'pornographic',
      ]);
      expect(ratingsFor('erotica')).toEqual(['safe', 'suggestive', 'erotica']);
    });

    it('未知 / 空档位一律退回默认', () => {
      for (const v of ['bogus', '', null, undefined]) {
        expect(ratingsFor(v)).toEqual(['safe', 'suggestive']);
      }
    });
  });

  describe('成人内容分级', () => {
    it('erotica 与 pornographic 判为成人', () => {
      expect(isAdultRating('erotica')).toBe(true);
      expect(isAdultRating('pornographic')).toBe(true);
    });

    it('safe 与 suggestive 不判为成人', () => {
      expect(isAdultRating('safe')).toBe(false);
      expect(isAdultRating('suggestive')).toBe(false);
    });

    it('未提供分级时不误判为成人', () => {
      expect(isAdultRating(undefined)).toBe(false);
    });
  });

  describe('图片 URL 拼接', () => {
    const pages = {
      baseUrl: 'https://cmdxd98sb0x3yprd.mangadex.network',
      hash: 'abc123',
      files: ['1-a.jpg', '2-b.jpg', '3-c.jpg'],
    };

    it('按序号拼出完整地址', () => {
      expect(pageImageUrl(pages, 0)).toBe('https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/1-a.jpg');
      expect(pageImageUrl(pages, 2)).toBe('https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/3-c.jpg');
    });

    it('越界页码返回 null', () => {
      expect(pageImageUrl(pages, 3)).toBeNull();
      expect(pageImageUrl(pages, -1)).toBeNull();
    });

    it('空章节返回 null', () => {
      expect(pageImageUrl({ baseUrl: 'https://x', hash: 'h', files: [] }, 0)).toBeNull();
    });
  });

  describe('标签分组', () => {
    it('按 group 归类，供详情页分块展示', () => {
      const tags: MangaTag[] = [
        { id: '1', name: 'Action', group: 'genre' },
        { id: '2', name: 'School Life', group: 'theme' },
        { id: '3', name: 'Shounen', group: 'demographic' },
        { id: '4', name: 'Romance', group: 'genre' },
      ];
      const grouped = groupTags(tags);
      expect(grouped.genre).toEqual(['Action', 'Romance']);
      expect(grouped.theme).toEqual(['School Life']);
      expect(grouped.demographic).toEqual(['Shounen']);
    });

    it('缺 group 的标签归入 theme（MangaDex 偶有）', () => {
      const grouped = groupTags([{ id: 'x', name: 'Mystery', group: '' }]);
      expect(grouped.theme).toEqual(['Mystery']);
    });
  });
});
