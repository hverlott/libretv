import { describe, it, expect } from 'vitest';
import {
  aggregateBrowseItems,
  buildTopCategoryMap,
  classify,
  classifyItem,
  classifyRegion,
  computeHeat,
  isAdultEntry,
  normalizeTitle,
  toNumber,
  BROWSE_CATEGORY_LABELS,
  BROWSE_REGION_LABELS,
} from './browse-parser';

describe('toNumber', () => {
  it('解析数字与数字字符串', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber('42')).toBe(42);
    expect(toNumber('7.6')).toBeCloseTo(7.6);
  });

  it('非法值返回 0', () => {
    expect(toNumber('')).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Infinity)).toBe(0);
  });
});

describe('normalizeTitle', () => {
  it('忽略标点与大小写差异', () => {
    expect(normalizeTitle('庆余年2')).toBe(normalizeTitle('庆余年 2'));
    expect(normalizeTitle('Hello World')).toBe(normalizeTitle('helloworld'));
    expect(normalizeTitle('摔跤吧！爸爸')).toBe(normalizeTitle('摔跤吧爸爸'));
  });
});

describe('classify', () => {
  it('归并各站同义分类名', () => {
    expect(classify('电影')).toBe('movie');
    expect(classify('电影片')).toBe('movie');
    expect(classify('连续剧')).toBe('tv');
    expect(classify('国产剧')).toBe('tv');
    expect(classify('欧美剧')).toBe('tv');
    expect(classify('韩国剧')).toBe('tv');
    expect(classify('动漫')).toBe('anime');
    expect(classify('国产动漫')).toBe('anime');
    expect(classify('日本动漫')).toBe('anime');
    expect(classify('大陆综艺')).toBe('variety');
    expect(classify('港台综艺')).toBe('variety');
    expect(classify('纪录片')).toBe('doc');
    expect(classify('短剧')).toBe('short');
  });

  it('成人分类单独成类，不落入 movie/other', () => {
    expect(classify('伦理片')).toBe('adult');
    expect(classify('福利片')).toBe('adult');
    expect(classify('里番动漫')).toBe('adult');
    expect(classify('无码')).toBe('adult');
    expect(classify('成人内容')).toBe('adult');
    expect(classify('麻豆传媒')).toBe('adult');
  });

  it('综艺优先于剧集判定', () => {
    // 「综艺剧」含「剧」，但应归到综艺
    expect(classify('综艺剧')).toBe('variety');
  });

  it('未知分类归入 other', () => {
    expect(classify(undefined)).toBe('other');
    expect(classify('')).toBe('other');
    expect(classify('都市言情')).toBe('other');
  });

  it('体育类单独归类', () => {
    expect(classify('体育')).toBe('sports');
    expect(classify('篮球')).toBe('sports');
    expect(classify('赛事')).toBe('sports');
  });
});

describe('buildTopCategoryMap', () => {
  it('只取顶级分类（type_pid=0）', () => {
    const map = buildTopCategoryMap([
      { type_id: 1, type_pid: 0, type_name: '电影' },
      { type_id: 2, type_pid: 0, type_name: '连续剧' },
      { type_id: 20, type_pid: 1, type_name: '动作片' },
    ]);
    expect(map.get('1')).toBe('电影');
    expect(map.get('2')).toBe('连续剧');
    expect(map.get('20')).toBeUndefined();
  });

  it('type_pid 缺失时视为顶级', () => {
    const map = buildTopCategoryMap([{ type_id: 7, type_name: '综艺' }]);
    expect(map.get('7')).toBe('综艺');
  });
});

describe('classifyItem', () => {
  it('优先用一级分类判定', () => {
    // 二级名是「动作片」（看不出是电影），一级名「电影片」才能定位
    const map = buildTopCategoryMap([{ type_id: 1, type_pid: 0, type_name: '电影片' }]);
    expect(classifyItem(1, '动作片', map)).toBe('movie');
  });

  it('一级分类缺失时回退二级分类名', () => {
    const map = new Map<string, string>();
    expect(classifyItem(99, '国产剧', map)).toBe('tv');
  });

  it('一级分类无法归类时也回退二级名', () => {
    const map = buildTopCategoryMap([{ type_id: 5, type_pid: 0, type_name: '伦理片' }]);
    // 伦理片现在归为 adult（而非落到 other），是明确分类而非回退
    expect(classifyItem(5, '国产剧', map)).toBe('adult');
  });

  it('一级分类是普通分类时按一级分类名判定', () => {
    const map = buildTopCategoryMap([{ type_id: 6, type_pid: 0, type_name: '连续剧' }]);
    expect(classifyItem(6, '国产剧', map)).toBe('tv');
  });

  it('类型归类时优先判定电影而非动作片子类', () => {
    const map = buildTopCategoryMap([{ type_id: 1, type_pid: 0, type_name: '电影' }]);
    // 若误用二级名「动作片」会归 other，一级名才正确
    expect(classifyItem(1, '动作片', map)).toBe('movie');
  });

  it('type_id_1=0 时用 type_id 查顶级分类表', () => {
    // 实测：源站给新建顶级分类（短剧 id=46）填 type_id_1=0
    const map = buildTopCategoryMap([
      { type_id: 46, type_pid: 0, type_name: '短剧' },
      { type_id: 52, type_pid: 0, type_name: 'AI漫剧' },
    ]);
    expect(classifyItem(0, '短剧', map, 46)).toBe('short');
    expect(classifyItem(0, 'AI漫剧', map, 52)).toBe('anime');
  });

  it('type_id_1=0 且 type_id 也查不到时回退二级名', () => {
    const map = buildTopCategoryMap([{ type_id: 46, type_pid: 0, type_name: '短剧' }]);
    expect(classifyItem(0, '国产剧', map, 999)).toBe('tv');
  });
});

describe('computeHeat', () => {
  it('收录源数是主导信号', () => {
    const manySources = computeHeat({ sourceCount: 10, hits: 0, score: 0, doubanScore: 0 });
    const oneSource = computeHeat({ sourceCount: 1, hits: 100000, score: 10, doubanScore: 10 });
    expect(manySources).toBeGreaterThan(oneSource);
  });

  it('豆瓣分权重高于源站评分', () => {
    const douban = computeHeat({ sourceCount: 1, hits: 0, score: 0, doubanScore: 9 });
    const source = computeHeat({ sourceCount: 1, hits: 0, score: 9, doubanScore: 0 });
    expect(douban).toBeGreaterThan(source);
  });

  it('播放量做 log 压缩，不让单个爆款拉平榜单', () => {
    const low = computeHeat({ sourceCount: 1, hits: 100, score: 0, doubanScore: 0 });
    const high = computeHeat({ sourceCount: 1, hits: 1000000, score: 0, doubanScore: 0 });
    // 播放量差 4 个数量级，分差不应超过 120
    expect(high - low).toBeLessThan(120);
  });
});

describe('isAdultEntry', () => {
  it('按分类名与片名识别成人内容', () => {
    expect(isAdultEntry({ typeName: '伦理片' })).toBe(true);
    expect(isAdultEntry({ typeName: '福利片' })).toBe(true);
    expect(isAdultEntry({ name: '无码合集' })).toBe(true);
    expect(isAdultEntry({ typeName: '国产剧', name: '庆余年' })).toBe(false);
  });

  it('与 classify 的判定口径一致：归为 adult 的条目一定被判为成人', () => {
    for (const name of ['伦理片', '福利片', '里番动漫', '无码', '成人内容', '麻豆传媒']) {
      expect(classify(name)).toBe('adult');
      expect(isAdultEntry({ typeName: name })).toBe(true);
    }
  });
});

describe('aggregateBrowseItems', () => {
  const srcA = { sourceKey: 'a', sourceName: '源A', sourceUrl: 'https://a.test/api.php/provide/vod' };
  const srcB = { sourceKey: 'b', sourceName: '源B', sourceUrl: 'https://b.test/api.php/provide/vod' };

  it('跨源同名片合并为一条并统计源数', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: '1', vod_name: '庆余年', type_name: '国产剧', vod_pic: 'p1' }] },
      { ...srcB, items: [{ vod_id: '2', vod_name: '庆余年', type_name: '国产剧', vod_pic: 'p2' }] },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].sourceCount).toBe(2);
    expect(list[0].sources).toHaveLength(2);
  });

  it('标点差异的同名片也能合并', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: '1', vod_name: '摔跤吧！爸爸', type_name: '电影' }] },
      { ...srcB, items: [{ vod_id: '2', vod_name: '摔跤吧爸爸', type_name: '电影' }] },
    ]);
    expect(list).toHaveLength(1);
  });

  it('热度高的排在前面', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: '1', vod_name: '冷门剧', type_name: '国产剧' }] },
      {
        ...srcB,
        items: [
          {
            vod_id: '2',
            vod_name: '热门剧',
            type_name: '国产剧',
            vod_hits: 50000,
            vod_score: 9,
            vod_douban_score: 8.5,
          },
        ],
      },
    ]);
    expect(list[0].name).toBe('热门剧');
    expect(list[0].doubanScore).toBe(8.5);
  });

  it('多源收录比单源高分更热门', () => {
    const srcC = { sourceKey: 'c', sourceName: '源C', sourceUrl: 'https://c.test/api.php/provide/vod' };
    const srcD = { sourceKey: 'd', sourceName: '源D', sourceUrl: 'https://d.test/api.php/provide/vod' };
    const { list } = aggregateBrowseItems([
      // 单源但评分满分
      { ...srcA, items: [{ vod_id: '1', vod_name: '独苗高分', type_name: '国产剧', vod_score: 10 }] },
      // 三个源都收录但无评分
      { ...srcB, items: [{ vod_id: '2', vod_name: '众人拾柴', type_name: '国产剧' }] },
      { ...srcC, items: [{ vod_id: '3', vod_name: '众人拾柴', type_name: '国产剧' }] },
      { ...srcD, items: [{ vod_id: '4', vod_name: '众人拾柴', type_name: '国产剧' }] },
    ]);
    expect(list[0].name).toBe('众人拾柴');
    expect(list[0].sourceCount).toBe(3);
  });

  it('同一源内的重复条目只计一个源', () => {
    const { list } = aggregateBrowseItems([
      {
        ...srcA,
        items: [
          { vod_id: '1', vod_name: '同片', type_name: '国产剧' },
          { vod_id: '2', vod_name: '同片', type_name: '国产剧' },
        ],
      },
    ]);
    expect(list[0].sourceCount).toBe(1);
  });

  it('按分类过滤时只返回该分类的片', () => {
    const { list } = aggregateBrowseItems(
      [
        {
          ...srcA,
          items: [
            { vod_id: '1', vod_name: '一部电影', type_name: '电影' },
            { vod_id: '2', vod_name: '一部剧', type_name: '国产剧' },
          ],
        },
      ],
      { category: 'movie' }
    );
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('一部电影');
  });

  it('成人过滤开关生效', () => {
    const items = [{ vod_id: '1', vod_name: '某剧', type_name: '伦理片' }];
    expect(aggregateBrowseItems([{ ...srcA, items }], { filterAdult: true }).list).toHaveLength(0);
    expect(aggregateBrowseItems([{ ...srcA, items }], { filterAdult: false }).list).toHaveLength(1);
  });

  it('缺少片名或 ID 的条目被跳过', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: '1' }, { vod_name: '无ID' }, { vod_id: '3', vod_name: '正常' }] },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('正常');
  });

  it('vod_id 为数字时也能识别（源站 JSON 里 vod_id 多数是数字）', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: 158332, vod_name: '数字ID剧', type_name: '国产剧' }] },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('数字ID剧');
    expect(list[0].vodId).toBe('158332');
  });

  it('vod_id 为 0 时视为无效', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: 0, vod_name: '零ID剧', type_name: '国产剧' }] },
    ]);
    expect(list).toHaveLength(0);
  });

  it('热度字段为字符串时能正确参与排序', () => {
    const { list } = aggregateBrowseItems([
      {
        ...srcA,
        items: [
          { vod_id: '1', vod_name: '字符串热度', type_name: '国产剧', vod_hits: '50000', vod_score: '8.5' },
          { vod_id: '2', vod_name: '无热度', type_name: '国产剧' },
        ],
      },
    ]);
    expect(list[0].name).toBe('字符串热度');
    expect(list[0].hits).toBe(50000);
    expect(list[0].score).toBe(8.5);
  });

  it('limit 生效', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      vod_id: String(i),
      vod_name: `剧${i}`,
      type_name: '国产剧',
    }));
    const { list } = aggregateBrowseItems([{ ...srcA, items }], { limit: 5 });
    expect(list).toHaveLength(5);
  });

  it('优先选有封面的条目作为展示项', () => {
    const { list } = aggregateBrowseItems([
      { ...srcA, items: [{ vod_id: '1', vod_name: '同片', type_name: '国产剧' }] },
      { ...srcB, items: [{ vod_id: '2', vod_name: '同片', type_name: '国产剧', vod_pic: 'https://img/p.jpg' }] },
    ]);
    expect(list[0].pic).toBe('https://img/p.jpg');
  });
});

describe('BROWSE_CATEGORY_LABELS', () => {
  it('每个分类都有中文标签', () => {
    expect(BROWSE_CATEGORY_LABELS.movie).toBe('电影');
    expect(BROWSE_CATEGORY_LABELS.tv).toBe('剧集');
    expect(BROWSE_CATEGORY_LABELS.anime).toBe('动漫');
  });
});

describe('BROWSE_REGION_LABELS', () => {
  it('每个地区都有中文标签', () => {
    expect(BROWSE_REGION_LABELS.cn).toBe('国产');
    expect(BROWSE_REGION_LABELS.us).toBe('欧美');
    expect(BROWSE_REGION_LABELS.jp).toBe('日本');
  });
});

describe('classifyRegion', () => {
  it('按二级分类名判定地区（area 缺失时）', () => {
    expect(classifyRegion('欧美剧')).toBe('us');
    expect(classifyRegion('美国剧')).toBe('us');
    expect(classifyRegion('日本剧')).toBe('jp');
    expect(classifyRegion('韩国剧')).toBe('kr');
    expect(classifyRegion('泰国剧')).toBe('th');
    expect(classifyRegion('台湾剧')).toBe('tw');
    expect(classifyRegion('香港剧')).toBe('hk');
    expect(classifyRegion('国产剧')).toBe('cn');
    expect(classifyRegion('大陆剧')).toBe('cn');
  });

  it('area 是单一国家时优先于分类名（更精确）', () => {
    // 分类名说日本、area 说美国：area 更具体，以 area 为准
    expect(classifyRegion('日本剧', '美国')).toBe('us');
    expect(classifyRegion('欧美剧', '日本')).toBe('jp');
  });

  it('area 缺失时用分类名兜底', () => {
    expect(classifyRegion('剧情片', '日本')).toBe('jp');
    expect(classifyRegion('剧情片', '美国')).toBe('us');
    expect(classifyRegion('剧情片', '中国大陆')).toBe('cn');
    expect(classifyRegion('剧情片', '英国')).toBe('uk');
  });

  it('多国并列的 area 不作为单一地区依据，回退分类名', () => {
    // 「日韩剧」横跨日韩，即便 area 写日本也不能算成日本
    expect(classifyRegion('日韩剧', '日本 / 韩国 / 中国香港')).toBe('other');
    expect(classifyRegion('日韩剧', '日本')).toBe('other');
    expect(classifyRegion('欧美剧', '英国 / 美国')).toBe('us');
  });

  it('无法判定时归入 other', () => {
    expect(classifyRegion(undefined, undefined)).toBe('other');
    expect(classifyRegion('剧情片', '')).toBe('other');
  });
});

describe('aggregateBrowseItems · 地区过滤', () => {
  const srcA = { sourceKey: 'a', sourceName: '源A', sourceUrl: 'https://a.test/api.php/provide/vod' };

  it('按地区筛选只返回该地区的片', () => {
    const { list } = aggregateBrowseItems(
      [
        {
          ...srcA,
          items: [
            { vod_id: '1', vod_name: '美剧A', type_name: '欧美剧', vod_area: '美国' },
            { vod_id: '2', vod_name: '日剧B', type_name: '日本剧', vod_area: '日本' },
            { vod_id: '3', vod_name: '国产C', type_name: '国产剧', vod_area: '中国大陆' },
          ],
        },
      ],
      { region: 'us' }
    );
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('美剧A');
    expect(list[0].region).toBe('us');
  });

  it('默认不过滤地区', () => {
    const { list } = aggregateBrowseItems([
      {
        ...srcA,
        items: [
          { vod_id: '1', vod_name: '美剧A', type_name: '欧美剧' },
          { vod_id: '2', vod_name: '日剧B', type_name: '日本剧' },
        ],
      },
    ]);
    expect(list).toHaveLength(2);
  });
});
