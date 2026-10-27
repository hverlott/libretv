import { describe, expect, it } from 'vitest';
import {
  applyContentFilter,
  DEFAULT_CONTENT_FILTER,
  DEFAULT_MIN_RATING,
  filterByRating,
  isAdultContent,
  isAdultText,
  parseRating,
} from './content-filter';
import { ADULT_KEYWORDS } from './adult-keywords';

describe('成人内容判定', () => {
  it('命中成人关键词', () => {
    expect(isAdultText('伦理片')).toBe(true);
    expect(isAdultText('日本福利片')).toBe(true);
    expect(isAdultText('里番动漫')).toBe(true);
    expect(isAdultText('擦边短剧')).toBe(true);
  });

  it('普通分类不误判', () => {
    expect(isAdultText('动作片')).toBe(false);
    expect(isAdultText('喜剧')).toBe(false);
    expect(isAdultText('科幻')).toBe(false);
    expect(isAdultText('纪录片')).toBe(false);
  });

  it('空值安全', () => {
    expect(isAdultText(undefined)).toBe(false);
    expect(isAdultText(null)).toBe(false);
    expect(isAdultText('')).toBe(false);
  });

  it('isAdultContent 同时看分类名与片名', () => {
    expect(isAdultContent({ typeName: '伦理片' })).toBe(true);
    expect(isAdultContent({ name: '某某福利社' })).toBe(true);
    expect(isAdultContent({ title: '成人动画' })).toBe(true);
    expect(isAdultContent({ typeName: '电影', name: '战狼' })).toBe(false);
  });

  it('词表包含此前 cms-parser 漏掉的词', () => {
    // 改造前 cms-parser 有一份**不完整**的词表副本，
    // 导致这些词在搜索结果里被过滤、在首页却露出来
    for (const kw of ['成人', '色情', '情色', '麻豆']) {
      expect(ADULT_KEYWORDS).toContain(kw);
      expect(isAdultText(kw)).toBe(true);
    }
  });
});

describe('评分解析', () => {
  it('字符串与数字都能解析', () => {
    expect(parseRating('8.5')).toBe(8.5);
    expect(parseRating(7)).toBe(7);
    expect(parseRating('8.0')).toBe(8);
  });

  it('无评分 / 0 分 / 非法值返回 undefined', () => {
    expect(parseRating(undefined)).toBeUndefined();
    expect(parseRating(null)).toBeUndefined();
    expect(parseRating('0')).toBeUndefined();
    expect(parseRating(0)).toBeUndefined();
    expect(parseRating('abc')).toBeUndefined();
  });
});

describe('按评分筛选', () => {
  const items = [
    { name: 'A', rating: '9.0' },
    { name: 'B', rating: '6.5' },
    { name: 'C', rating: '5.0' },
    { name: 'D' }, // 无评分
  ];

  it('全选模式不做评分过滤', () => {
    const r = filterByRating(items, { mode: 'all', minRating: DEFAULT_MIN_RATING });
    expect(r).toHaveLength(4);
  });

  it('只看有评分：无评分的被排除', () => {
    const r = filterByRating(items, { mode: 'rated', minRating: DEFAULT_MIN_RATING });
    expect(r.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('评分门槛可调', () => {
    const r = filterByRating(items, { mode: 'rated', minRating: 8 });
    expect(r.map((i) => i.name)).toEqual(['A']);
  });

  it('门槛为 0 时保留所有有评分的条目', () => {
    const r = filterByRating(items, { mode: 'rated', minRating: 0 });
    expect(r.map((i) => i.name)).toEqual(['A', 'B', 'C']);
  });

  it('支持 doubanScore 字段（热门剧集用）', () => {
    const browse = [
      { name: 'X', doubanScore: 8.2 },
      { name: 'Y', doubanScore: 5.1 },
      { name: 'Z' },
    ];
    const r = filterByRating(browse, { mode: 'rated', minRating: 6 });
    expect(r.map((i) => i.name)).toEqual(['X']);
  });
});

describe('综合筛选', () => {
  const items = [
    { name: '正常高分', rating: '8.0' },
    { name: '正常低分', rating: '4.0' },
    { name: '伦理片', typeName: '伦理片', rating: '7.0' },
    { name: '某福利片', rating: '9.0' },
    { name: '无评分' },
  ];

  const isAdult = (i: (typeof items)[number]) => isAdultContent({ typeName: i.typeName, name: i.name });

  it('成人内容在「全选」模式下也被剔除', () => {
    // 关键：全选只影响评分门槛，成人内容必须始终过滤
    const r = applyContentFilter(items, { mode: 'all', minRating: 6 }, isAdult);
    expect(r.map((i) => i.name)).toEqual(['正常高分', '正常低分', '无评分']);
  });

  it('「只看有评分」叠加成人过滤', () => {
    const r = applyContentFilter(items, { mode: 'rated', minRating: 6 }, isAdult);
    expect(r.map((i) => i.name)).toEqual(['正常高分']);
  });

  it('默认设置是全选 + 6 分门槛', () => {
    expect(DEFAULT_CONTENT_FILTER.mode).toBe('all');
    expect(DEFAULT_CONTENT_FILTER.minRating).toBe(DEFAULT_MIN_RATING);
    expect(DEFAULT_MIN_RATING).toBe(6);
  });
});
