import { describe, expect, it } from 'vitest';
import {
  MATCH_THRESHOLD,
  chineseToNumber,
  cleanTitle,
  compareKey,
  diceCoefficient,
  extractSeason,
  normalizeYear,
  pickBest,
  scoreCandidate,
  type MatchCandidate,
} from './match';

describe('cleanTitle', () => {
  it('去掉尾随年份（源站常把年份粘在名字后面）', () => {
    expect(cleanTitle('爱情来了2026')).toBe('爱情来了');
    expect(cleanTitle('骤雨(2026)')).toBe('骤雨');
  });

  it('去掉清晰度与语言标签', () => {
    expect(cleanTitle('流浪地球2 HD国语')).toBe('流浪地球2');
    expect(cleanTitle('某某电影 蓝光高清')).toBe('某某电影');
    expect(cleanTitle('测试 4K')).toBe('测试');
  });

  it('去掉「更新至18集」这类进度信息', () => {
    expect(cleanTitle('剧名 更新至18集')).toBe('剧名');
    expect(cleanTitle('剧名 全34集')).toBe('剧名');
  });

  it('保留季数：它是区分作品的关键，不是噪声（中文数字统一成阿拉伯数字便于对齐）', () => {
    expect(cleanTitle('小猪佩奇 第8季')).toBe('小猪佩奇 第8季');
    expect(cleanTitle('庆余年 第二季')).toBe('庆余年 第2季');
  });

  it('不砍掉片名自带的数字（「流浪地球2」不是第二季）', () => {
    expect(cleanTitle('流浪地球2')).toBe('流浪地球2');
    expect(cleanTitle('沙丘2')).toBe('沙丘2');
  });

  it('去站点水印', () => {
    expect(cleanTitle('电影名@某某影视')).toBe('电影名');
  });

  it('空值安全', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle(undefined)).toBe('');
    expect(cleanTitle(null)).toBe('');
  });
});

describe('compareKey', () => {
  it('中文数字与阿拉伯数字对齐（豆瓣写「第八季」，源站写「第8季」）', () => {
    expect(compareKey('小猪佩奇 第八季')).toBe(compareKey('小猪佩奇 第8季'));
  });

  it('忽略大小写、空格与标点', () => {
    expect(compareKey('RUNNING   MAN')).toBe(compareKey('running man'));
  });
});

describe('extractSeason', () => {
  it('识别中文与英文写法', () => {
    expect(extractSeason('庆余年 第二季')).toBe(2);
    expect(extractSeason('小猪佩奇 第8季')).toBe(8);
    expect(extractSeason('Friends Season 3')).toBe(3);
    expect(extractSeason('Friends S03')).toBe(3);
  });

  it('不把片名里的裸数字当成季数', () => {
    expect(extractSeason('流浪地球2')).toBeUndefined();
    expect(extractSeason('破事精英 3')).toBeUndefined();
  });

  it('越界与缺失返回 undefined', () => {
    expect(extractSeason('')).toBeUndefined();
    expect(extractSeason('第零季')).toBeUndefined();
  });
});

describe('chineseToNumber', () => {
  it('支持 1-99 的中文数字', () => {
    expect(chineseToNumber('一')).toBe(1);
    expect(chineseToNumber('十')).toBe(10);
    expect(chineseToNumber('十一')).toBe(11);
    expect(chineseToNumber('二十一')).toBe(21);
    expect(chineseToNumber('99')).toBe(99);
  });
});

describe('normalizeYear', () => {
  it('从区间与脏值里取年份', () => {
    expect(normalizeYear('2024-2025')).toBe(2024);
    expect(normalizeYear('2024(中国大陆)')).toBe(2024);
    expect(normalizeYear('')).toBeUndefined();
    expect(normalizeYear(undefined)).toBeUndefined();
  });
});

describe('diceCoefficient', () => {
  it('相同为 1，完全不同为 0', () => {
    expect(diceCoefficient('abc', 'abc')).toBe(1);
    expect(diceCoefficient('abc', 'xyz')).toBe(0);
  });

  it('短串无法构成二元组时退化为相等判断', () => {
    expect(diceCoefficient('a', 'a')).toBe(1);
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  it('部分重叠落在 0-1 之间', () => {
    const value = diceCoefficient('周处除三害', '周处除三害之宿命');
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});

describe('scoreCandidate', () => {
  it('标题完全一致得分最高', () => {
    const exact = scoreCandidate({ title: '周处除三害', year: '2023' }, { title: '周处除三害', year: '2023', score: 8.1 });
    const loose = scoreCandidate({ title: '周处除三害', year: '2023' }, { title: '周处除三害之宿命', year: '2025', score: 7 });
    expect(exact).toBeGreaterThan(loose);
  });

  it('季数冲突大幅降权 —— 不给错季的分', () => {
    const sameSeason = scoreCandidate({ title: '庆余年 第二季' }, { title: '庆余年 第二季', year: '2024', score: 7.3 });
    const otherSeason = scoreCandidate({ title: '庆余年 第二季' }, { title: '庆余年 第一季', year: '2019', score: 7.9 });
    expect(sameSeason).toBeGreaterThan(otherSeason);
    expect(otherSeason).toBeLessThan(MATCH_THRESHOLD);
  });

  it('源站带季数而候选不带季时也降权（别拿单季的分当整体的分）', () => {
    const withSeason = scoreCandidate({ title: '破事精英 第二季' }, { title: '破事精英 第二季', score: 8.6 });
    const withoutSeason = scoreCandidate({ title: '破事精英 第二季' }, { title: '破事精英', score: 7.9 });
    expect(withSeason).toBeGreaterThan(withoutSeason);
  });

  it('年份相距过远降权', () => {
    const near = scoreCandidate({ title: '周处除三害', year: '2023' }, { title: '周处除三害', year: '2023', score: 8.1 });
    const far = scoreCandidate({ title: '周处除三害', year: '2023' }, { title: '周处除三害', year: '1994', score: 8.1 });
    expect(near).toBeGreaterThan(far);
  });

  it('源标题尾部的裸数字在候选里找不到对应季时降权', () => {
    // 「破事精英 3」在豆瓣上没有第三季，不该拿第一季 7.9 顶上
    const score = scoreCandidate({ title: '破事精英 3' }, { title: '破事精英', year: '2022', score: 7.9 });
    expect(score).toBeLessThan(MATCH_THRESHOLD);
  });

  it('类型一致小幅加分', () => {
    const same = scoreCandidate({ title: 'X', kind: 'movie' }, { title: 'X', score: 8, kind: 'movie' });
    const diff = scoreCandidate({ title: 'X', kind: 'movie' }, { title: 'X', score: 8, kind: 'tv' });
    expect(same).toBeGreaterThan(diff);
  });
});

describe('pickBest', () => {
  const candidates: MatchCandidate[] = [
    { title: '周处除三害', year: '2023', score: 8.1, votes: 1210072 },
    { title: '周处除三害之宿命', year: '2025', score: 0, votes: 0 },
    { title: '周处除三害(韩版)', year: '2030', score: 0, votes: 0 },
  ];

  it('挑中最可信的一条', () => {
    const best = pickBest({ title: '周处除三害', year: '2023' }, candidates);
    expect(best?.candidate.title).toBe('周处除三害');
    expect(best?.candidate.score).toBe(8.1);
  });

  it('未开分（score=0）的条目不参与选择', () => {
    const best = pickBest({ title: '仿生迷踪' }, [
      { title: '仿生迷踪', year: '2026', score: 0, votes: 0 },
    ]);
    expect(best).toBeUndefined();
  });

  it('宁缺毋滥：低于阈值就返回 undefined', () => {
    const best = pickBest({ title: '破事精英 3' }, [{ title: '破事精英 第二季', year: '2023', score: 8.6 }]);
    expect(best).toBeUndefined();
  });

  it('空候选返回 undefined', () => {
    expect(pickBest({ title: 'X' }, [])).toBeUndefined();
  });

  it('同名多候选时按评分人数偏好正片', () => {
    const best = pickBest({ title: '肖申克的救赎' }, [
      { title: '肖申克的救赎', year: '1994', score: 9.7, votes: 3353526 },
      { title: '肖申克的救赎', year: '1994', score: 9.5, votes: 12 },
    ]);
    expect(best?.candidate.votes).toBe(3353526);
  });
});
