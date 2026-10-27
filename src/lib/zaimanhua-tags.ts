/**
 * 再漫画的筛选常量。
 *
 * 单独放一个文件（与 `mangadex-tags.ts` 对称）是为了让**客户端组件也能直接导入** ——
 * `zaimanhua.ts` 依赖 `fetchUpstream`（服务端），不能进浏览器 bundle。
 *
 * 这些 id 都是上游 `comic/filter/list` 的参数值，取自 Venera 源脚本
 * `venera-app/venera-configs/zaimanhua.js`，并做了实测校正：
 * - 「日常」的 id 以详情接口实测的 `tag_id=30788` 为准（源脚本标成 23388，与实测不符）
 * - 题材 / 地区 / 受众 / 状态 / 排序五组参数均经实测确认生效
 */

/** 一个筛选选项：key 是上游参数值，label 是中文显示名 */
export interface ZaiOption {
  key: string;
  label: string;
}

/**
 * 题材（`theme` 参数）。
 * 上游没有题材列表接口，这张表是静态的。实测总库约 2 万部中文漫画。
 */
export const ZAI_CATEGORIES: ZaiOption[] = [
  { key: '0', label: '全部' },
  { key: '4', label: '冒险' },
  { key: '5848', label: '奇幻' },
  { key: '5806', label: '魔幻' },
  { key: '3365', label: '西方魔幻' },
  { key: '23388', label: '仙侠' },
  { key: '3324', label: '武侠' },
  { key: '13', label: '校园' },
  { key: '30788', label: '日常' },
  { key: '8', label: '爱情' },
  { key: '3246', label: '纯爱' },
  { key: '3254', label: '治愈' },
  { key: '6', label: '格斗' },
  { key: '3248', label: '热血' },
  { key: '7', label: '科幻' },
  { key: '3325', label: '机战' },
  { key: '9', label: '侦探' },
  { key: '3245', label: '悬疑' },
  { key: '14', label: '惊悚' },
  { key: '10', label: '竞技' },
  { key: '11', label: '魔法' },
  { key: '12', label: '神鬼' },
  { key: '5', label: '欢乐向' },
  { key: '7568', label: '搞笑' },
  { key: '3250', label: '历史' },
  { key: '3251', label: '战争' },
  { key: '3255', label: '励志' },
  { key: '16', label: '其他' },
  { key: '17', label: '四格' },
  { key: '3242', label: '亲情' },
  { key: '3252', label: '萌系' },
  { key: '3253', label: '宅系' },
  { key: '3326', label: '音乐舞蹈' },
  { key: '3327', label: '美食' },
  { key: '3328', label: '职场' },
  { key: '6316', label: '轻小说' },
  { key: '23323', label: '生存' },
  { key: '4459', label: '高清单行' },
  { key: '13627', label: '动画' },
];

/**
 * 地区（`zone` 参数）—— 这是再漫画比 MangaDex 强的地方：
 * 全部是**汉化**内容，MangaDex 的韩漫有中文译本的只有 17 部。
 * 实测存量：内地 20112 / 日本 134 / 欧美 17 / 韩国 4 / 港台 1。
 */
export const ZAI_ZONES: ZaiOption[] = [
  { key: '0', label: '全部' },
  { key: '2308', label: '内地' },
  { key: '2304', label: '日本' },
  { key: '2305', label: '韩国' },
  { key: '2306', label: '欧美' },
  { key: '2307', label: '港台' },
  { key: '8435', label: '其他' },
];

/** 受众（`cate` 参数） */
export const ZAI_CATES: ZaiOption[] = [
  { key: '0', label: '全部' },
  { key: '3262', label: '少年漫画' },
  { key: '3263', label: '少女漫画' },
  { key: '3264', label: '青年漫画' },
  { key: '13626', label: '女青漫画' },
];

/** 连载状态（`status` 参数） */
export const ZAI_STATUSES: ZaiOption[] = [
  { key: '0', label: '全部' },
  { key: '2309', label: '连载中' },
  { key: '2310', label: '已完结' },
  { key: '29205', label: '短篇' },
];

/**
 * 排序（`sortType` 参数）。
 * key 沿用全站的 MangaSortKey 语义，在客户端里映射成上游数字。
 */
export const ZAI_SORTS: ZaiOption[] = [
  { key: 'latest', label: '最近更新' },
  { key: 'popular', label: '人气' },
];

/** MangaSortKey → 上游 sortType；未识别的一律回落「最近更新」 */
export function zaiSortType(sort: string | null | undefined): number {
  return sort === 'popular' ? 2 : 1;
}

/** 白名单：只放行内置表里的取值，避免任意字符串被拼进上游 URL */
export function zaiAllow(key: string | null | undefined, options: ZaiOption[]): string {
  if (!key) return '0';
  return options.some((o) => o.key === key) ? key : '0';
}
