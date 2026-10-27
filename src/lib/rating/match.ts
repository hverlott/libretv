/**
 * 片名归一化与候选匹配（纯函数，不碰网络）。
 *
 * ## 为什么需要
 *
 * 采集站标题是脏的：「小猪佩奇 第8季」「破事精英 3」「爱情来了2026」「流浪地球2 HD国语」。
 * 评分站的标题是干净的：「小猪佩奇 第八季」「破事精英 第二季」「爱情来了」「流浪地球2」。
 * 直接拿源标题去搜，要么搜不到，要么匹配到错误的季（把第二季的分贴到第三季上）。
 *
 * 匹配失败的代价是「没有评分」（无害），匹配错误的代价是「显示别人家的分」（有害），
 * 所以这里的策略是**宁缺毋滥**：季数冲突、年份冲突都直接降到阈值以下，宁可不显示。
 */

/** 中文数字 → 阿拉伯数字（1–99，够用于季数与部数） */
const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function cnNumberToArabic(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  // 「十」单独出现时，下面的正则两个捕获组都为空，先直接认掉
  if (raw === '十') return 10;
  // 「十一」/「二十」/「二十一」
  const tenMatch = raw.match(/^(?:([一二三四五六七八九])?十)?([一二三四五六七八九])?$/);
  if (!tenMatch) return undefined;
  const [, tens, ones] = tenMatch;
  if (!tens && !ones) return undefined;
  const t = tens ? CN_DIGITS[tens] : raw.includes('十') ? 1 : 0;
  const o = ones ? CN_DIGITS[ones] : 0;
  const value = t * 10 + o;
  return value >= 1 && value <= 99 ? value : undefined;
}

/**
 * 清晰度 / 语言 / 版本 / 站点水印等噪声。
 * 这些词在采集站标题里高频出现，在评分站标题里几乎不出现，留着只会拉低相似度。
 */
const NOISE =
  /\s*[（(【\[]?\s*(?:BD|HD|4K|8K|TC|TS|CAM|DVDRip|WEB-?DL|WEBRip|HDTV|蓝光|高清|超清|标清|抢先版|预告|正宗|国语|粤语|英语|日语|韩语|普通话|中字|双语|无字幕|未删减|完整版|全集|免费|在线观看|会员|独播|VIP)\s*[）)】\]]?/gi;

/** 进度信息：「更新至18集」「全34集」「第12集」 */
const PROGRESS = /(更新至|更新到|更至|共|全|至)?\s*\d+\s*[集期话部回]|更新至\d+/g;

/** 单集标记：只认「第N集」这种明确指向单集的，不认裸数字（否则「流浪地球2」会被砍成「流浪地球」） */
const EPISODE = /第\s*[0-9一二三四五六七八九十]+\s*[集期话回]/g;

/** 尾部 4 位年份：源标题常把年份粘在名字后面（「爱情来了2026」） */
const TRAILING_YEAR = /[(（]?\s*(?:19|20)\d{2}\s*[)）]?\s*$/;

/** 站点水印：形如「@某某影视」「某某资源站」 */
const WATERMARK = /[@＠]\s*\S{1,12}$/;

const CN_NUM_MAP: Record<string, string> = {
  零: '0',
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
};

/** 全角/半角、大小写、标点统一 */
function unify(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[·・•]/g, '')
    .replace(/\s+/g, ' ');
}

/** 把标题里的中文数字季/部换成阿拉伯数字，便于「第八季」与「第8季」对齐 */
function arabicizeNumbers(raw: string): string {
  return raw.replace(/第\s*([零一二两三四五六七八九十\d]+)\s*([季部篇])/g, (_m, digits: string, unit: string) => {
    const n = cnNumberToArabic(digits);
    return n === undefined ? `第${digits}${unit}` : `第${n}${unit}`;
  });
}

/**
 * 清洗用于展示/检索的标题：去噪词、去进度、去单集、去水印、去尾随年份。
 * 保留季数（「第二季」是区分作品的关键信息，不是噪声）。
 */
export function cleanTitle(raw: string | undefined | null): string {
  if (!raw) return '';
  let t = unify(raw);
  t = t.replace(WATERMARK, '');
  t = t.replace(PROGRESS, '');
  t = t.replace(EPISODE, '');
  t = t.replace(NOISE, '');
  t = t.replace(TRAILING_YEAR, '');
  t = arabicizeNumbers(t);
  return t.trim();
}

/**
 * 比较用主键：去掉一切空白与标点。
 * 「小猪佩奇 第八季」→「小猪佩奇第八季」
 */
export function compareKey(raw: string | undefined | null): string {
  const cleaned = cleanTitle(raw);
  const flat = cleaned.replace(/[\s\p{P}\p{S}]/gu, '');
  return flat || cleaned.toLowerCase().replace(/\s+/g, '');
}

/**
 * 提取季数。只认明确写法，不认尾部裸数字——
 * 「流浪地球2」是片名的一部分，不是第二季。
 */
export function extractSeason(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const text = unify(raw);
  const m =
    text.match(/第\s*([零一二两三四五六七八九十\d]+)\s*[季部篇]/) ??
    text.match(/\bseason\s*(\d{1,2})\b/) ??
    text.match(/[\s_]s(\d{1,2})(?:[\s_]|$)/);
  if (!m) return undefined;
  const n = cnNumberToArabic(m[1]);
  return n && n >= 1 && n <= 99 ? n : undefined;
}

/** 归一化年份：源里常见「2024-2025」「2024(中国大陆)」，取第一个 4 位数字 */
export function normalizeYear(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const m = String(raw).match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : undefined;
}

/** 二元组 Dice 系数：对中文短标题比编辑距离更稳（不依赖分词） */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const left = grams.get(g) ?? 0;
    if (left > 0) {
      grams.set(g, left - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

export type MediaKind = 'movie' | 'tv';

export interface MatchCandidate {
  title?: string;
  year?: string | number;
  /** 评分站侧的评分（0–10） */
  score: number;
  /** 评分人数 */
  votes?: number;
  kind?: MediaKind;
  /** 评分站侧条目 id（拼详情页链接用） */
  externalId?: string;
}

export interface MatchQuery {
  title: string;
  year?: string;
  kind?: MediaKind;
}

/** 低于该相似度即视为不可信，宁可不显示 */
export const MATCH_THRESHOLD = 0.68;

/**
 * 候选打分。返回 0–1 区间的可信度（含季/年/类型修正，可能小于 0）。
 */
export function scoreCandidate(query: MatchQuery, candidate: MatchCandidate): number {
  const qKey = compareKey(query.title);
  const cKey = compareKey(candidate.title);
  if (!qKey || !cKey) return 0;

  let sim: number;
  if (qKey === cKey) {
    sim = 1;
  } else {
    const dice = diceCoefficient(qKey, cKey);
    // 一方完整包含另一方（「周处除三害」⊂「周处除三害之宿命」）给到 0.85，
    // 否则遇到「原名 vs 原名+副标题」会被 Dice 稀释到阈值以下
    const contains = qKey.includes(cKey) || cKey.includes(qKey);
    const containment = contains ? 0.85 : 0;
    sim = Math.max(dice, containment);
  }

  // 源标题尾部的裸数字（「破事精英 3」）当作季数线索处理：
  // 候选里找不到这个数字，说明候选是另一季（或本部），不该拿它的分顶上。
  // 「流浪地球2」「沙丘2」这类数字是片名的一部分，候选标题里同样带它，不受影响。
  const trailingDigit = qKey.match(/\d+$/)?.[0];
  if (trailingDigit && !cKey.includes(trailingDigit)) sim -= 0.35;

  const qSeason = extractSeason(query.title);
  const cSeason = extractSeason(candidate.title);
  if (qSeason !== undefined) {
    // 源明确说了第几季：候选必须同季，否则是另一部作品
    if (cSeason === undefined) sim -= 0.5;
    else if (cSeason !== qSeason) sim -= 0.7;
  } else if (cSeason !== undefined) {
    // 源没说季（可能是总条目或合并条目），候选带季 → 轻度降权，别拿单季的分当整体的分
    sim -= 0.2;
  }

  const qYear = normalizeYear(query.year) ?? normalizeYear(query.title);
  const cYear = normalizeYear(candidate.year ? String(candidate.year) : undefined);
  if (qYear && cYear) {
    const delta = Math.abs(qYear - cYear);
    if (delta <= 1) sim += 0.1;
    else if (delta >= 4) sim -= 0.45;
    else if (delta >= 2) sim -= 0.2;
  }

  if (query.kind && candidate.kind && query.kind === candidate.kind) sim += 0.05;

  // 同分时优先评分人数多的条目（正片 vs 同名花絮 / 原声碟）
  if (candidate.votes && candidate.votes > 0) {
    sim += Math.min(Math.log10(candidate.votes + 1) / 20, 0.05);
  }

  return sim;
}

export interface RankedCandidate<T> {
  candidate: T;
  score: number;
}

/**
 * 从候选里挑最可信的一条。返回 undefined 表示「不可信，宁缺毋滥」。
 */
export function pickBest<T extends MatchCandidate>(
  query: MatchQuery,
  candidates: readonly T[],
  threshold: number = MATCH_THRESHOLD
): RankedCandidate<T> | undefined {
  let best: RankedCandidate<T> | undefined;
  for (const candidate of candidates) {
    // 未开分的条目（score=0）不参与选择：它「存在」但不值得展示
    if (!(candidate.score > 0)) continue;
    const score = scoreCandidate(query, candidate);
    if (!best || score > best.score) best = { candidate, score };
  }
  if (!best || best.score < threshold) return undefined;
  return best;
}

/** 数字形式的中文数字串（供测试与外部使用） */
export function chineseToNumber(raw: string): number | undefined {
  return cnNumberToArabic(raw);
}

export { CN_NUM_MAP };
