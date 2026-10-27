/**
 * MangaDex 标签与筛选项的静态定义。
 *
 * 之所以做成静态表而不是全靠 `/manga/tag` 动态返回：
 * 1. 标签的**英文名是稳定的**，但 MangaDex 只提供英文名，界面需要中文；
 * 2. 需要**剔除**不适合做成分类入口的标签（见 `EXCLUDED_TAGS`）；
 * 3. 分类顺序按浏览习惯排（动作/恋爱在前），而不是 API 返回的字母序。
 */

/** 一个可筛选的标签（id 来自 `/manga/tag`，会随站点数据变化，故只在运行时配对） */
export interface MangaTagOption {
  id: string;
  /** 英文原名（用于匹配 API 返回值） */
  name: string;
  /** 界面显示名 */
  zh: string;
}

/** 漫画列表排序方式；值为 MangaDex 的 `order[xxx]=desc` 字段名 */
export type MangaSortKey = 'latest' | 'popular' | 'rating' | 'newest';

export interface MangaSortOption {
  key: MangaSortKey;
  label: string;
  /** MangaDex order 字段 */
  order: string;
}

export interface MangaFilterOption {
  key: string;
  label: string;
}

export const MANGA_SORTS: MangaSortOption[] = [
  { key: 'latest', label: '最新更新', order: 'latestUploadedChapter' },
  { key: 'popular', label: '最受欢迎', order: 'followedCount' },
  { key: 'rating', label: '高评分', order: 'rating' },
  { key: 'newest', label: '新作上架', order: 'createdAt' },
];

/** 受众群体 → MangaDex 的 `publicationDemographic[]` */
export const MANGA_DEMOGRAPHICS: MangaFilterOption[] = [
  { key: 'shounen', label: '少年' },
  { key: 'shoujo', label: '少女' },
  { key: 'seinen', label: '青年' },
  { key: 'josei', label: '女性' },
];

/** 连载状态 → MangaDex 的 `status[]` */
export const MANGA_STATUSES: MangaFilterOption[] = [
  { key: 'ongoing', label: '连载中' },
  { key: 'completed', label: '已完结' },
  { key: 'hiatus', label: '休刊' },
  { key: 'cancelled', label: '已取消' },
];

/**
 * 翻译语言 → MangaDex 的 `availableTranslatedLanguage[]`。
 * 站上英文译本占绝大多数（约 4.9 万部），中文仅数百部，
 * 所以「只看中文」是真实需求，但必须让用户知道量级差距。
 */
export const MANGA_LANGS: MangaFilterOption[] = [
  { key: 'zh', label: '有中文' },
  { key: 'zh-hk', label: '有繁体' },
  { key: 'en', label: '有英文' },
  { key: 'ja', label: '有日文' },
];

/**
 * 原作地区 → MangaDex 的 `originalLanguage[]`。
 *
 * 实测存量（safe + suggestive）：日本 6.8 万 / 韩国 7517 / 中文 5964 / 欧美 2555。
 * 韩漫有英文译本的 4684 部、有中文译本的仅 17 部——量大但基本得看英文版。
 */
export const MANGA_ORIGINS: MangaFilterOption[] = [
  { key: 'ja', label: '日本漫画' },
  { key: 'ko', label: '韩国漫画' },
  { key: 'zh', label: '国漫' },
  { key: 'en', label: '欧美漫画' },
];

/**
 * 内容分级 → MangaDex 的 `contentRating[]`，档位**向下累积**：
 * 选 `pornographic` 时同时包含 safe + suggestive + erotica。
 *
 * 三档：
 * - 不选（默认）= safe + suggestive，不含成人向；
 * - `erotica` = 成人向（MangaDex 上约 1.5 万部）；
 * - `pornographic` = 限制级（约 2 万部）。
 *
 * 之所以敢开放 `pornographic`：这一档用的是 MangaDex 官方审核打的分级字段，
 * 而不是关键词猜测，且 `BLOCKED_TAGS` 在**所有**请求里都从上游排除（并事后兜底）。
 * 相比之下，第三方盗版聚合站没有分级元数据、无法可靠过滤，因此不接入。
 *
 * 是否展示这两档由全站的「成人内容过滤」开关决定
 * （`yellowFilter` 关闭时才出现），与点播侧的成人源是同一套规则。
 */
export const MANGA_RATINGS: MangaFilterOption[] = [
  { key: 'erotica', label: '含成人向' },
  { key: 'pornographic', label: '限制级' },
];

/**
 * 分级档位白名单校验：未知取值一律退回空串（= 不含成人向）。
 *
 * 路由层用它在拼上游 URL 之前就把参数收窄，避免任意字符串透传。
 */
export function normalizeMangaRating(value?: string | null): string {
  return MANGA_RATINGS.some((r) => r.key === value) ? String(value) : '';
}

/**
 * 上游硬排除的标签：无论用户选了什么筛选项，带这些标签的作品都不会返回。
 *
 * 与 `EXCLUDED_TAGS` 的区别：
 * - `EXCLUDED_TAGS` 只是**不提供分类入口**，作品本身仍可出现（详情页保留内容警示）；
 * - `BLOCKED_TAGS` 是**直接从结果里剔除**，走 MangaDex 的 `excludedTags[]`，
 *   并在返回后再兜一层过滤，避免上游参数失效时漏出来。
 */
export const BLOCKED_TAGS = new Set(['Loli', 'Shota', 'Incest']);

/**
 * 不作为分类展示的标签。
 *
 * - `Sexual Violence` / `Gore` 属于 `content` 组，是内容警示标记，不是题材；
 * - `Loli` / `Shota` / `Incest` 涉及未成年性化，不提供分类入口。
 *   这些标签仍会出现在详情页的作品标签里（用户需要知道内容警示），
 *   只是不能被主动筛选、也不能当成"想看什么"的入口。
 */
export const EXCLUDED_TAGS = new Set([
  'Sexual Violence',
  'Gore',
  'Loli',
  'Shota',
  'Incest',
]);

/** 题材（genre）中文名，顺序即界面展示顺序 */
const GENRE_ZH: [string, string][] = [
  ['Action', '动作'],
  ['Adventure', '冒险'],
  ['Comedy', '喜剧'],
  ['Drama', '剧情'],
  ['Fantasy', '奇幻'],
  ['Romance', '恋爱'],
  ['Sci-Fi', '科幻'],
  ['Slice of Life', '日常'],
  ['Mystery', '悬疑'],
  ['Horror', '恐怖'],
  ['Thriller', '惊悚'],
  ['Isekai', '异世界'],
  ['Mecha', '机甲'],
  ['Sports', '运动'],
  ['Historical', '历史'],
  ['Crime', '犯罪'],
  ['Psychological', '心理'],
  ['Philosophical', '哲理'],
  ['Medical', '医疗'],
  ['Superhero', '超级英雄'],
  ['Magical Girls', '魔法少女'],
  ['Wuxia', '武侠'],
  ['Tragedy', '悲剧'],
  ['Boys’ Love', '耽美'],
  ['Boys\' Love', '耽美'],
  ['Girls’ Love', '百合'],
  ['Girls\' Love', '百合'],
];

/** 主题（theme）中文名 */
const THEME_ZH: [string, string][] = [
  ['Reincarnation', '转生'],
  ['Time Travel', '时空穿越'],
  ['Genderswap', '性转'],
  ['Traditional Games', '传统棋牌'],
  ['Monsters', '怪物'],
  ['Demons', '恶魔'],
  ['Ghosts', '幽灵'],
  ['Animals', '动物'],
  ['Ninja', '忍者'],
  ['Survival', '生存'],
  ['Zombies', '丧尸'],
  ['Reverse Harem', '逆后宫'],
  ['Martial Arts', '武术'],
  ['Samurai', '武士'],
  ['Mafia', '黑帮'],
  ['Virtual Reality', '虚拟现实'],
  ['Office Workers', '职场'],
  ['Video Games', '电子游戏'],
  ['Post-Apocalyptic', '末世'],
  ['Crossdressing', '女装'],
  ['Magic', '魔法'],
  ['Harem', '后宫'],
  ['Military', '军事'],
  ['School Life', '校园'],
  ['Mahjong', '麻将'],
  ['Villainess', '恶役千金'],
  ['Vampires', '吸血鬼'],
  ['Delinquents', '不良少年'],
  ['Monster Girls', '怪物娘'],
  ['Police', '警察'],
  ['Aliens', '外星人'],
  ['Cooking', '料理'],
  ['Supernatural', '超自然'],
  ['Music', '音乐'],
  ['Gyaru', '辣妹'],
];

/** 形式（format）中文名 */
const FORMAT_ZH: [string, string][] = [
  ['Oneshot', '单篇'],
  ['Award Winning', '获奖作品'],
  ['Official Colored', '官方彩版'],
  ['Long Strip', '条漫'],
  ['Anthology', '合集'],
  ['Fan Colored', '爱好者上色'],
  ['Self-Published', '同人出版'],
  ['4-Koma', '四格'],
  ['Doujinshi', '同人志'],
  ['Web Comic', '网络漫画'],
  ['Adaptation', '改编'],
  ['Full Color', '全彩'],
];

function toMap(pairs: [string, string][]): Map<string, string> {
  return new Map(pairs);
}

const GENRE_MAP = toMap(GENRE_ZH);
const THEME_MAP = toMap(THEME_ZH);
const FORMAT_MAP = toMap(FORMAT_ZH);

/** 取标签中文名；未收录则返回英文原名 */
export function tagLabel(name: string, group: string): string {
  if (group === 'genre') return GENRE_MAP.get(name) || name;
  if (group === 'theme') return THEME_MAP.get(name) || name;
  if (group === 'format') return FORMAT_MAP.get(name) || name;
  return name;
}

/**
 * 标签的界面排序权重：按预定义顺序，未收录的排最后。
 * 让「动作/恋爱」出现在「悲剧/哲理」之前，符合浏览习惯。
 */
export function tagOrder(name: string, group: string): number {
  const map = group === 'genre' ? GENRE_MAP : group === 'theme' ? THEME_MAP : FORMAT_MAP;
  const keys = [...map.keys()];
  const i = keys.indexOf(name);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** 连载状态中文名（详情页复用） */
export function statusLabelZh(status: string): string {
  return MANGA_STATUSES.find((s) => s.key === status)?.label || status;
}

/** 受众群体中文名 */
export function demographicLabelZh(key: string): string {
  return MANGA_DEMOGRAPHICS.find((d) => d.key === key)?.label || key;
}
