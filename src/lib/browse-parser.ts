import type { BrowseItem, BrowseCategory } from './types';
import { isAdultContent, isAdultText as isAdultTextShared } from './content-filter';

/**
 * 热门剧集聚合（服务端纯函数层）。
 *
 * 采集站不提供「热门」排序接口（实测 type / orderby 参数被源忽略），
 * 但列表接口返回的条目带多个可用的热度信号：
 * - vod_hits：源站播放点击量
 * - vod_score：源站评分
 * - vod_douban_score：豆瓣评分（仅部分源有）
 * - vod_time：源站入库时间
 *
 * 跨源聚合时，「多少个源同时收录」本身就是最强的热度信号——
 * 全网 15 个源都有的剧，比任一源自己打分 9.0 的剧更热门。
 */

/** 源站列表接口的单条原始条目（只取用到的字段） */
export interface RawListItem {
  vod_id?: unknown;
  vod_name?: unknown;
  vod_pic?: unknown;
  type_name?: unknown;
  /** 二级分类 id（type_id_1=0 时它本身即顶级分类 id） */
  type_id?: unknown;
  /** 一级分类 id（配合 ac=list 的分类表翻译成一级分类名） */
  type_id_1?: unknown;
  vod_year?: unknown;
  vod_area?: unknown;
  vod_remarks?: unknown;
  vod_hits?: unknown;
  vod_score?: unknown;
  vod_douban_score?: unknown;
  vod_time?: unknown;
}

/**
 * 源站分类表条目（ac=list 返回）
 */
export interface RawClassItem {
  type_id?: unknown;
  type_pid?: unknown;
  type_name?: unknown;
}

/** 归一化标题：去空白、标点与符号，转小写。用于跨源同名合并。 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 安全转数字：源站字段可能是字符串、数字或空值 */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s || undefined;
}

/**
 * ID 归一化：源站的 vod_id 在 JSON 里是数字（实测 1090/1090 条为 int），
 * 但部分源返回字符串，因此两种都要接受——只认字符串会丢掉绝大多数条目。
 * 数字 0 是无效 ID（采集站 ID 从 1 开始），视为空。
 */
function idStr(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return '';
    return String(value);
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * 成人内容关键词（分类归并与内容过滤共用同一份表）。
 *
 * 共用的原因：若两处用不同的词表，会出现「分类归到 adult 却没被过滤掉」
 * 或「被过滤掉却归到别的分类」的错位——前者是漏过滤，后者是分类名不准。
 *
 * 词表本身在 adult-keywords.ts（唯一来源），判定逻辑在 content-filter.ts
 * （首页各内容区共用），此处只做转出以保持既有导入方兼容。
 */
export { ADULT_KEYWORDS } from './adult-keywords';

/**
 * 分类归一化：把源站五花八门的分类名收敛为可切换的分类。
 * 源站的分类名各站不同（电影/电影片/大片、连续剧/电视剧/内地剧…），
 * 直接展示会让筛选栏变成一锅粥，因此按关键词归并。
 *
 * 一级分类（type_id_1 经 ac=list 翻译）优先：二级分类名里混着大量
 * 综艺与剧集的细分（港台综艺/大陆综艺/国产剧/欧美剧…），
 * 单看二级名会漏掉「电影」——因为二级名是「动作片/喜剧片」这类子类。
 */
const CATEGORY_RULES: { category: BrowseCategory; patterns: RegExp[] }[] = [
  // 综艺：先判综艺，避免「综艺剧」被误分到剧集
  { category: 'variety', patterns: [/综艺/, /真人秀/, /脱口秀/, /娱乐/, /访谈/] },
  { category: 'anime', patterns: [/动漫/, /动画/, /漫画/, /番剧/, /漫剧/, /卡通/] },
  // 纪录片要先于电影判定，否则「纪录片」会被 /片$/ 抢走
  { category: 'doc', patterns: [/纪录/, /纪录片/, /科教/, /记录片/] },
  { category: 'movie', patterns: [/电影/, /大片/, /影视/, /剧场/, /片$/] },
  { category: 'short', patterns: [/短剧/, /竖屏/, /微短剧/] },
  { category: 'sports', patterns: [/体育/, /赛事/, /球/] },
  { category: 'tv', patterns: [/剧/, /连续剧/, /美剧/, /韩剧/, /日剧/, /泰剧/, /台剧/, /港/, /欧美/, /国产/, /内地/, /海外/] },
];

export function classify(typeName: string | undefined): BrowseCategory {
  if (!typeName) return 'other';
  // 成人分类先于其它规则判定：否则「伦理片」会被 /片$/ 归成电影。
  // 单独成类（而非塞进 other），部署者关闭内容过滤后可直接按此分类浏览。
  if (isAdultText(typeName)) return 'adult';
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(typeName))) return rule.category;
  }
  return 'other';
}

/** 文本是否命中成人关键词（与内容过滤共用同一实现，避免两处判定漂移） */
function isAdultText(text: string): boolean {
  return isAdultTextShared(text);
}

/**
 * 构建「一级分类 id → 分类名」映射表。
 *
 * 只取 type_pid 为 0 / 缺失的顶级分类——子类（如「动作片」）不参与，
 * 否则「动作片」会被判成 movie，把国产剧里的动作片也算进电影。
 */
export function buildTopCategoryMap(classes: RawClassItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of classes) {
    const id = idStr(c.type_id);
    const name = str(c.type_name);
    if (!id || !name) continue;
    const pid = c.type_pid === undefined || c.type_pid === null ? 0 : Number(c.type_pid);
    // type_pid=0 表示顶级分类；部分源不返回 type_pid，此时只要 class 列表本身
    // 就是顶级的（Apple CMS 的 ac=list 默认返回顶级 + 部分二级混合，需靠 type_pid 区分）
    if (pid === 0) map.set(id, name);
  }
  return map;
}

/**
 * 判定条目所属分类。
 *
 * 源的 type_id_1 指向一级分类，但部分源对「新建的顶级分类」会填 0
 * （实测量子源的短剧 id=46、AI漫剧 id=52 都以 type_id_1=0 出现），
 * 此时条目的 type_id 本身就是顶级分类 id，需回退查表。
 *
 * 优先级：一级分类名 → type_id 查表 → 二级分类名。
 */
export function classifyItem(
  typeId1: unknown,
  typeName: string | undefined,
  topMap: Map<string, string>,
  typeId?: unknown
): BrowseCategory {
  const id1 = idStr(typeId1);
  if (id1 && id1 !== '0') {
    const top = topMap.get(id1);
    if (top) {
      const c = classify(top);
      if (c !== 'other') return c;
    }
  }
  // type_id_1=0（或缺失）：用 type_id 再查一次顶级分类表
  const id = idStr(typeId);
  if (id && id !== '0') {
    const top = topMap.get(id);
    if (top) {
      const c = classify(top);
      if (c !== 'other') return c;
    }
  }
  return classify(typeName);
}

/** 归一化后的地区（源站的 vod_area 与二级分类名各站不同，统一收敛） */
export type BrowseRegion = 'all' | 'cn' | 'us' | 'uk' | 'jp' | 'kr' | 'tw' | 'hk' | 'th' | 'other';

/**
 * 地区归并规则。
 *
 * 源站没有「地区」这个一级分类——海外内容混在「连续剧/电视剧」下面，
 * 靠二级分类名（欧美剧/日本剧/韩国剧…）和 vod_area 字段区分。
 *
 * 两个信号的分工：
 * - vod_area 更精确（写的是「美国」「日本」这种具体国家），但常常缺失或写成多国并列；
 * - 二级分类名覆盖面广（欧美剧/美国剧），但粒度粗——「日韩剧」这种合称会同时命中日韩。
 *
 * 因此：**area 是单一国家时以 area 为准**（更准），area 缺失或并列多国时才用分类名。
 * 否则「日韩剧」会全被算进韩国，日本片就找不到了。
 */
const REGION_RULES: { region: BrowseRegion; areaPatterns: RegExp[]; typePatterns: RegExp[] }[] = [
  // 合称分类（日韩剧/日韩动漫…）横跨两个地区，单独归 other。
  // 必须排在具体国家规则之前——否则「日韩剧」会被算进其中一个国家，
  // 另一半的内容就找不到了。
  { region: 'other', areaPatterns: [], typePatterns: [/日韩/] },
  // 顺序有讲究：先判具体国家/地区，再判泛化的「欧美/亚洲」
  { region: 'cn', areaPatterns: [/中国/, /大陆/, /内地/, /国产/], typePatterns: [/国产/, /大陆/, /内地/, /中国/] },
  { region: 'tw', areaPatterns: [/台湾/, /台灣/], typePatterns: [/台湾/, /台剧/, /台综/] },
  { region: 'hk', areaPatterns: [/香港/, /港台/, /港澳/], typePatterns: [/香港/, /港台/, /港剧/, /港综/] },
  { region: 'jp', areaPatterns: [/日本/, /日語/, /日语/], typePatterns: [/日本/, /日剧/, /日综/, /日漫/] },
  { region: 'kr', areaPatterns: [/韩国/, /韩语/, /韓國/], typePatterns: [/韩国/, /韩剧/, /韩综/] },
  { region: 'th', areaPatterns: [/泰国/, /泰國/], typePatterns: [/泰国/, /泰剧/] },
  { region: 'uk', areaPatterns: [/英国/, /英國/, /英格兰/], typePatterns: [/英剧/, /英国/] },
  { region: 'us', areaPatterns: [/美国/, /美國/, /加拿大/, /墨西哥/, /巴西/], typePatterns: [/美国/, /美剧/, /欧美剧/, /西剧/] },
  // 泛化：欧美（英美之外的西方剧）
  { region: 'us', areaPatterns: [/欧美/, /欧洲/, /德国/, /法国/, /意大利/, /西班牙/, /俄罗斯/, /澳洲/, /澳大利亚/], typePatterns: [/欧美/, /欧洲/] },
];

/**
 * area 是多国并列时（"日本 / 韩国 / 中国香港"）不能作为单一地区的依据。
 * 用分隔符判断：斜杠、逗号、顿号、加号分隔即视为多国。
 */
function isMultiRegionArea(area: string): boolean {
  return /[/,、+&]/.test(area);
}

/**
 * 判定条目所属地区。
 *
 * @param typeName 二级分类名（欧美剧/日本剧/…）
 * @param area     源站的 vod_area 字段（中国大陆/日本/美国/…）
 */
export function classifyRegion(typeName: string | undefined, area?: string): BrowseRegion {
  const t = typeName ?? '';
  const a = (area ?? '').trim();
  // 合称分类名优先否决：日韩剧/日韩动漫 横跨两个地区，
  // 即便 area 写了「日本」也不能算成日本——那样韩国那半边就找不到了。
  if (t.includes('日韩')) return 'other';
  // area 是单一国家/地区时最精确，优先采用
  if (a && !isMultiRegionArea(a)) {
    for (const rule of REGION_RULES) {
      if (rule.areaPatterns.some((p) => p.test(a))) return rule.region;
    }
  }
  // area 缺失或并列多国 → 用二级分类名
  for (const rule of REGION_RULES) {
    if (rule.typePatterns.some((p) => p.test(t))) return rule.region;
  }
  // 分类名也判不出 → other。
  // 多国 area 不要再兜底到某个具体国家：并列多国的片子归到任一国家都不对，
  // 归 other 才能在「其它」里如实呈现。
  return 'other';
}

export const BROWSE_REGION_LABELS: Record<BrowseRegion, string> = {
  all: '全部地区',
  cn: '国产',
  us: '欧美',
  uk: '英国',
  jp: '日本',
  kr: '韩国',
  tw: '台湾',
  hk: '香港',
  th: '泰国',
  other: '其他',
};

export const BROWSE_CATEGORY_LABELS: Record<BrowseCategory, string> = {
  all: '全部',
  movie: '电影',
  tv: '剧集',
  anime: '动漫',
  variety: '综艺',
  doc: '纪录片',
  short: '短剧',
  sports: '体育',
  adult: '成人',
  other: '其他',
};

/** 单个源里的一条候选（已解析） */
interface Candidate {
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  hits: number;
  score: number;
  doubanScore: number;
  time: number;
  category: BrowseCategory;
  region: BrowseRegion;
}

/**
 * 热度分：多源收录数是主信号，播放量/评分/豆瓣分是次信号。
 * 权重刻意让「被多少个源收录」压过单源的分数——单源打分常年虚高不可信。
 */
export function computeHeat(candidate: {
  sourceCount: number;
  hits: number;
  score: number;
  doubanScore: number;
}): number {
  const { sourceCount, hits, score, doubanScore } = candidate;
  // 多源收录：每个源贡献 100 分（15 源 → 1500），是主导项
  let heat = sourceCount * 100;
  // 播放量：log 压缩，避免单个爆款拉平整个榜单
  heat += Math.log10(hits + 1) * 30;
  // 源站评分：0-10 映射到 0-40
  heat += Math.min(Math.max(score, 0), 10) * 4;
  // 豆瓣评分：0-10 映射到 0-60，权重高于源站评分（跨源一致，更可信）
  heat += Math.min(Math.max(doubanScore, 0), 10) * 6;
  return heat;
}

/**
 * 聚合多个源的列表条目 → 热门剧集列表。
 *
 * 流程：解析 → 按归一化标题跨源合并 → 计算热度 → 排序 → 截断。
 * 合并时保留每个源各自的条目（用于「换源」时对比），主展示条目取热度信号最强的那个。
 */
export function aggregateBrowseItems(
  rawBySource: {
    sourceKey: string;
    sourceName: string;
    sourceUrl: string;
    items: RawListItem[];
    topCategories?: Map<string, string>;
  }[],
  options: {
    limit?: number;
    category?: BrowseCategory;
    region?: BrowseRegion;
    filterAdult?: boolean;
  } = {}
): { list: BrowseItem[]; totalSources: number } {
  const { limit = 120, category = 'all', region = 'all', filterAdult = true } = options;

  // 归一化标题 → 跨源分组
  const groups = new Map<string, Candidate[]>();
  for (const { sourceKey, sourceName, sourceUrl, items, topCategories } of rawBySource) {
    const topMap = topCategories ?? new Map<string, string>();
    for (const raw of items) {
      const name = str(raw.vod_name);
      const vodId = idStr(raw.vod_id);
      if (!name || !vodId) continue;
      const typeName = str(raw.type_name);
      const c: Candidate = {
        sourceKey,
        sourceName,
        sourceUrl,
        vodId,
        name,
        pic: str(raw.vod_pic),
        typeName,
        year: str(raw.vod_year),
        area: str(raw.vod_area),
        remarks: str(raw.vod_remarks),
        hits: toNumber(raw.vod_hits),
        score: toNumber(raw.vod_score),
        doubanScore: toNumber(raw.vod_douban_score),
        time: toNumber(raw.vod_time),
        category: classifyItem(raw.type_id_1, typeName, topMap, raw.type_id),
        region: classifyRegion(typeName, str(raw.vod_area)),
      };
      const key = normalizeTitle(name);
      if (!key) continue;
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }
  }

  const result: BrowseItem[] = [];
  for (const candidates of groups.values()) {
    // 展示条目：优先有封面的，其次热度信号最强的
    const primary =
      candidates.find((c) => c.pic && c.category !== 'other') ??
      candidates.find((c) => c.pic) ??
      candidates.slice().sort((a, b) => entryHeat(b) - entryHeat(a))[0];

    // 分类过滤：主条目分类不在目标分类时，若组内有其它条目落在目标分类则改用那个
    let chosen = primary;
    if (category !== 'all' && chosen.category !== category) {
      const alt = candidates.find((c) => c.category === category);
      if (!alt) continue;
      chosen = alt;
    }
    // 地区过滤：同理，主条目地区不匹配时找组内匹配的地区条目
    if (region !== 'all' && chosen.region !== region) {
      const alt = candidates.find((c) => c.region === region);
      if (!alt) continue;
      chosen = alt;
    }
    if (filterAdult && isAdultEntry(chosen)) continue;

    const sourceCount = new Set(candidates.map((c) => c.sourceKey)).size;
    const hits = Math.max(...candidates.map((c) => c.hits));
    const score = Math.max(...candidates.map((c) => c.score));
    const doubanScore = Math.max(...candidates.map((c) => c.doubanScore));

    result.push({
      name: chosen.name,
      pic: chosen.pic,
      typeName: chosen.typeName,
      year: chosen.year,
      area: chosen.area,
      remarks: chosen.remarks,
      category: chosen.category,
      region: chosen.region,
      vodId: chosen.vodId,
      sourceKey: chosen.sourceKey,
      sourceName: chosen.sourceName,
      sourceUrl: chosen.sourceUrl,
      sourceCount,
      hits,
      score,
      doubanScore: doubanScore > 0 ? doubanScore : undefined,
      heat: computeHeat({ sourceCount, hits, score, doubanScore }),
      /** 同片在各源的条目，供播放页换源使用 */
      sources: candidates.map((c) => ({
        sourceKey: c.sourceKey,
        sourceName: c.sourceName,
        sourceUrl: c.sourceUrl,
        vodId: c.vodId,
        name: c.name,
        typeName: c.typeName,
      })),
    });
  }

  // 热度降序；热度相同时按收录源数、播放量再排
  result.sort((a, b) => {
    if (b.heat !== a.heat) return b.heat - a.heat;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  return { list: result.slice(0, limit), totalSources: groups.size };
}

/** 单条目的粗略热度（用于挑选展示条目时的兜底比较） */
function entryHeat(c: Candidate): number {
  return Math.log10(c.hits + 1) * 30 + Math.min(Math.max(c.score, 0), 10) * 4 + c.doubanScore * 6;
}

/**
 * 成人内容判定（分类名或片名命中成人关键词）。
 * 与 classify 共用 ADULT_KEYWORDS，避免「归类成成人却没被过滤」这类错位。
 */
export function isAdultEntry(c: { typeName?: string; name?: string }): boolean {
  return isAdultContent(c);
}
