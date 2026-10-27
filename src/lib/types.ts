// 采集站（Apple CMS 资源站）描述
export interface SourceConfig {
  /** 唯一标识，如 "custom_0"；内置源直接用短名 */
  key: string;
  name: string;
  /** API 根地址，如 https://example.com/api.php/provide/vod */
  url: string;
  /** 可选：详情页根地址（部分源需要爬详情页提取 m3u8） */
  detail?: string;
  isAdult?: boolean;
}

export interface SearchResultItem {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  /** 自定义源的 API 地址，详情请求需要 */
  sourceUrl?: string;
  isAdult?: boolean;
}

export interface VideoInfo {
  title?: string;
  cover?: string;
  desc?: string;
  typeName?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
}

export interface VideoDetail {
  episodes: string[];
  videoInfo: VideoInfo;
}

export interface DoubanItem {
  id: string;
  title: string;
  cover: string;
  rating?: string;
  isTv?: boolean;
}

// —— 热门剧集浏览（跨源聚合） ——

/** 归一化后的分类（源站原始 type_name 各站不同，统一收敛） */
export type BrowseCategory =
  | 'all'
  | 'movie'
  | 'tv'
  | 'anime'
  | 'variety'
  | 'doc'
  | 'short'
  | 'sports'
  | 'adult'
  | 'other';

/** 归一化后的地区（源站无地区一级分类，由二级分类名 + vod_area 归并） */
export type BrowseRegion = 'all' | 'cn' | 'us' | 'uk' | 'jp' | 'kr' | 'tw' | 'hk' | 'th' | 'other';

/** 聚合列表中同一部剧在各源的条目（供换源对比） */
export interface BrowseItemSource {
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
  name: string;
  typeName?: string;
}

/** 热门剧集列表中的一条（跨源聚合后的影片） */
export interface BrowseItem {
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  category: BrowseCategory;
  /** 归一化后的地区 */
  region: BrowseRegion;
  /** 主展示条目（热度信号最强 / 有封面）对应的影片 ID */
  vodId: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  /** 收录该片的源数量——最强的热度信号 */
  sourceCount: number;
  /** 源站播放量 */
  hits: number;
  /** 源站评分 */
  score: number;
  /** 豆瓣评分（仅部分源提供） */
  doubanScore?: number;
  /** 综合热度分，用于排序 */
  heat: number;
  /** 同片在各源的条目 */
  sources: BrowseItemSource[];
}

export interface BrowseResponse {
  list: BrowseItem[];
  /** 参与聚合的源数量 */
  sourceCount: number;
  /** 各分类的条目数（用于分类 tab 显示数量） */
  categoryCounts: Record<BrowseCategory, number>;
  /** 各地区的条目数（用于地区筛选显示数量） */
  regionCounts: Record<BrowseRegion, number>;
  /** 失败的源 */
  failures: { sourceKey: string; error: string }[];
  /** 后台仍在深翻页补充数据（前端可提示「结果还在陆续补充」） */
  warming?: boolean;
}

export interface SourceSearchOutcome {
  sourceKey: string;
  ok: boolean;
  list: SearchResultItem[];
  error?: string;
  /** 因超时失败：源可能只是慢，前端以琥珀色区分于真正的失败 */
  timedOut?: boolean;
  /** 该源搜索总耗时（ms），用于健康徽章 */
  ms?: number;
}

// —— 画质（按「源 + 影片」记录） ——

/**
 * 画质记录条目。
 * `height` 为视频高度（像素），undefined 表示探测过但测不出（单码率 m3u8 / 直链）。
 * `from` 区分来源：play 是播放器实测的真实分辨率（权威），probe 是解析 m3u8 推断值。
 */
export interface QualityEntry {
  height?: number;
  from: 'play' | 'probe';
  /**
   * 探测失败原因（如 `HTTP 403`、`请求超时`）。
   * 有值 = 这次压根没探到；无值而 height 也缺失 = 探到了但源站没写画质信息。
   * 两者在 UI 上都显示「未知」，靠这个字段区分出「源站不给」和「我们没够着」。
   */
  error?: string;
  /** 记录时间（epoch ms），用于 LRU 淘汰与失败重试 */
  timestamp: number;
}

/** 画质探测请求条目：源配置 + 影片 ID */
export interface QualityProbeItem {
  source: SourceConfig;
  id: string;
}

/** 画质探测结果；height 缺失代表「测不出」而非失败失败（error 有值时才是失败） */
export interface QualityProbeResult {
  sourceKey: string;
  vodId: string;
  height?: number;
  error?: string;
}

// —— API 响应结构 ——

export interface SearchResponse {
  list: SearchResultItem[];
  failures: { sourceKey: string; error: string; timedOut?: boolean }[];
}

/** /api/search?stream=1 的 NDJSON 事件：逐源推送 + 最终聚合 */
export type SearchStreamEvent =
  | ({ type: 'source' } & SourceSearchOutcome)
  | { type: 'done'; list: SearchResultItem[]; failures: SearchResponse['failures'] };

export interface DoubanResponse {
  items: DoubanItem[];
}

export interface BangumiCalendarDay {
  /** 1=周一 … 7=周日 */
  weekday: number;
  items: DoubanItem[];
}

export interface BangumiCalendarResponse {
  days: BangumiCalendarDay[];
}

export interface AuthStatusResponse {
  /** 服务器是否配置了 PASSWORD */
  passwordRequired: boolean;
  /** 当前会话是否已验证 */
  verified: boolean;
  version: string;
  /** 部署者通过 DEFAULT_SOURCES 环境变量预置的采集站（未配置时为空数组） */
  defaultSources: SourceConfig[];
  /** 部署者通过 DEFAULT_LIVE_SOURCES 环境变量预置的直播源（未配置时为空数组） */
  defaultLiveSources: LiveSourceConfig[];
  /** 部署者通过 DEFAULT_SUBSCRIPTIONS 环境变量预置的 SourceList 订阅链接（未配置时为空数组） */
  defaultSubscriptions: { url: string; name?: string }[];
  /** 部署者通过 DEFAULT_RECOMMEND_SOURCE 环境变量指定的首页推荐数据源默认值（未配置时为 null） */
  defaultRecommendSource: 'douban' | 'bangumi' | 'hot-list' | null;
  /** 部署者通过 DEFAULT_IMAGE_MODE 环境变量指定的封面图加载方式默认值（未配置时为 null） */
  defaultImageMode: 'direct' | 'proxy' | null;
  /** 部署者通过 DEFAULT_ADULT_FILTER 环境变量指定的成人内容过滤默认值（未配置时为 null，沿用出厂默认 true=过滤开启） */
  defaultAdultFilter: boolean | null;
}

/** 隐私状态总览（/api/privacy/status） */
export interface PrivacyStatusResponse {
  /** 服务器是否配置了 PASSWORD */
  passwordConfigured: boolean;
  /** 当前会话是否已验证 */
  verified: boolean;
  /** 出站代理状态 */
  proxy: {
    enabled: boolean;
    kind: 'none' | 'http' | 'socks5';
    /** 脱敏后的代理地址（不含凭据）；未启用时为 null */
    endpoint: string | null;
    /** DNS 查询是否由代理端完成（= 运营商看不到你查了什么域名） */
    dnsProtected: boolean;
    /** 代理链路是否加密（= 运营商看不到目标域名与内容） */
    encrypted: boolean;
    /** 代理配置错误信息 */
    error: string | null;
  };
  /** 本地加密状态 */
  encryption: {
    available: boolean;
    note: string;
  };
  /** 传输与访问相关状态 */
  transport: {
    /** 播放与下载是否全部经本站同源代理 */
    sameOriginPlayback: boolean;
    /** 全局 Referrer 策略 */
    referrerPolicy: string;
    /** 服务绑定地址（127.0.0.1 表示仅本机可访问） */
    bindHost: string;
  };
  /** 运营商（ISP）可见性：逐项说明运营商能看到什么 */
  isp: {
    /** 是否强制 HTTPS 上游（否则搜索词明文可见） */
    httpsRequired: boolean;
    /** DNS 查询是否受保护（否则运营商知道你在查哪些采集站域名） */
    dnsProtected: boolean;
    /** 内容与目标域名是否受保护（否则运营商知道你在连哪个源、传什么） */
    contentProtected: boolean;
    /** DoH 是否启用 */
    dohEnabled: boolean;
    /** DoH 当前是否健康 */
    dohHealthy: boolean;
    /** 是否禁止回落到系统 DNS */
    dohOnly: boolean;
  };
  /**
   * 评分补全状态。
   * 这是全站唯一「主动把片名发给第三方」的功能，因此在隐私页单列说明。
   */
  rating: {
    /** 服务端是否开启（RATING_PROVIDER=none 时关闭） */
    enabled: boolean;
    /** 当前生效的提供方顺序 */
    providers: RatingProviderId[];
    /** TMDB 是否已配置 API key */
    tmdbConfigured: boolean;
    /** 豆瓣是否可用 */
    doubanEnabled: boolean;
    /** 已缓存的评分条数 */
    cacheSize: number;
    /** 各提供方是否处于被拒后的冷却期 */
    cooling: { tmdb: boolean; douban: boolean };
  };
}

// —— 直播 / IPTV ——

/** 直播源（M3U 订阅）配置 */
export interface LiveSourceConfig {
  key: string;
  name: string;
  /** M3U 订阅地址 */
  url: string;
  /** 可选：XMLTV 节目单地址 */
  epg?: string;
}

/** 单个直播频道（由 M3U 解析得到） */
export interface LiveChannel {
  /** tvg-id 优先，缺失时由 URL 生成的稳定短 id */
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  /** M3U 的 tvg-name 属性（原始台名） */
  rawName?: string;
}

export interface LivePlaylistResponse {
  /** 订阅名（M3U 无名时为空） */
  name?: string;
  channels: LiveChannel[];
  groups: string[];
}

/** 单条节目单条目（XMLTV programme） */
export interface EpgProgram {
  channelId: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  stop: number;
  title: string;
  desc?: string;
}

export interface LiveEpgResponse {
  channelId: string;
  current?: EpgProgram;
  next?: EpgProgram;
  programs: EpgProgram[];
}

// —— 服务端批量下载 ——

/** 单个下载任务（对应一集） */
export interface ServerDownloadTask {
  id: string;
  batchId: string;
  /** 影片名（不含集号） */
  title: string;
  /** 集号（1 基） */
  episode: number;
  /** 该集的总集数 */
  totalEpisodes: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  /** 已完成分片 */
  finished: number;
  /** 总分片 */
  total: number;
  /** 已下载字节 */
  bytes: number;
  /** 输出文件路径（完成后有效） */
  filePath?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** 一次「一键多选下载」操作对应的批次 */
export interface ServerDownloadBatch {
  id: string;
  label: string;
  taskIds: string[];
  createdAt: number;
}

/** 批次统计 */
export interface ServerDownloadBatchStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
  canceled: number;
  bytes: number;
}

/** /api/download/queue 的响应 */
export interface ServerDownloadQueue {
  batches: ServerDownloadBatch[];
  tasks: ServerDownloadTask[];
  batchStats?: Record<string, ServerDownloadBatchStats>;
}

/** 批量提交时选择的一部影片 */
export interface ServerDownloadSelection {
  source: SourceConfig;
  vodId: string;
  title: string;
  /** 只下前 N 集；不传则下全部 */
  maxEpisodes?: number;
}

/** POST /api/download/batch 的响应 */
export interface ServerDownloadBatchResult {
  batchId: string;
  taskIds: string[];
  /** 展开后的总集数 */
  episodeCount: number;
  /** 因超出单批上限被截断的集数 */
  truncated: number;
  stats: ServerDownloadBatchStats;
  /** 取详情失败的影片 */
  failures: { title: string; reason: string }[];
  resolved: { title: string; episodeCount: number }[];
  /** 服务端下载目录 */
  downloadDir: string;
  /** 输出格式 */
  format: 'TS' | 'MP4';
}

// —— 数据源订阅 ——

/** 订阅条目未被导入（跳过）的原因分类 */
export type SubscriptionSkipReason =
  /** Spider 类站点（csp_* / jar / js / py），需 TVBOX 引擎才能运行 */
  | 'spider'
  /** 仅提供 XML 接口或不支持的类型 */
  | 'xml'
  /** 站点自身标记为不可搜索（本站只有搜索入口，导入后无法使用） */
  | 'unsearchable'
  /** 直播源不是 M3U 播放列表（如 txt 频道列表、单仓 JSON） */
  | 'nonM3uLive'
  /** 地址非法、非 http(s) 或未通过服务端公网校验 */
  | 'invalidUrl';

/** 订阅解析统计：说明跳过与截断情况，用于导入结果提示 */
export interface SubscriptionParseStats {
  /** 识别出的订阅格式 */
  format: 'libretv' | 'tvbox';
  /** 被跳过的条目总数 */
  skipped: number;
  /** 跳过原因分类计数 */
  skippedByReason: Partial<Record<SubscriptionSkipReason, number>>;
  /** 被跳过条目的名称示例（最多 3 个），便于用户定位 */
  skippedSamples?: string[];
  /** 因超出数量上限被截断的条目数 */
  truncated: number;
}

/**
 * 远程订阅解析结果。
 * `sources` 为点播源（Apple CMS 采集站），`liveSources` 为直播源（M3U + 可选 EPG）。
 * 兼容两种订阅格式：LibreTV-SourceList JSON 与 TVBOX 配置 JSON（`sites` / `lives`）。
 * 老格式订阅只有 `sources`，此时 `liveSources` 为空数组。
 */
export interface SourceListPayload {
  /** 订阅列表自带名称 */
  name?: string;
  sources: Omit<SourceConfig, 'key'>[];
  liveSources: Omit<LiveSourceConfig, 'key'>[];
  /** 解析统计（格式、跳过与截断），老数据可能缺失 */
  stats?: SubscriptionParseStats;
}

/* ——————————————— 漫画（MangaDex / 再漫画） ——————————————— */

import type { MangaSourceId } from './manga-source-meta';

/** MangaDex 内容分级；erotica / pornographic 视为成人内容 */
export type MangaContentRating = 'safe' | 'suggestive' | 'erotica' | 'pornographic';

export interface MangaTag {
  id: string;
  name: string;
  group: string;
}

/** 漫画条目（搜索 / 详情共用） */
export interface MangaItem {
  id: string;
  title: string;
  altTitles: string[];
  description: string;
  cover: string | null;
  status: string | null;
  year: number | null;
  tags: MangaTag[];
  contentRating: MangaContentRating;
  chapterCount: number | null;
  /** 原作语言（ja / ko / zh / en…），用于标注来源地 */
  originalLanguage: string | null;
  /**
   * 作者名。目前只有再漫画给（中文名）；
   * MangaDex 的 relationships 里只有作者 id，要名字得再打一次 author 接口，暂不做。
   */
  authors?: string[];
}

/** 原作地区筛选（原作语言） */
export type MangaOriginKey = 'ja' | 'ko' | 'zh' | 'en';

/** 内容分级筛选档位；只提供「含成人向」一档，空值表示不含成人向 */
export type MangaRatingKey = 'erotica';

export interface MangaChapter {
  id: string;
  number: string | null;
  title: string | null;
  language: string;
  pages: number;
}

export interface MangaSearchResponse {
  items: MangaItem[];
  total: number;
  /** 实际使用的源（省略 source 参数时由服务端按默认源决定） */
  source?: MangaSourceId;
}

/** 本地漫画库里的一部作品（内容来自本机目录，不来自任何在线源） */
export interface LocalWorkSummary {
  id: string;
  title: string;
  chapterCount: number;
  pageCount: number;
  /** 封面是本站图片代理地址，不是本机文件路径 */
  cover: string | null;
  updatedAt: number;
}

/** 书库里扫到但没能收录的条目（让用户知道为什么列表是空的） */
export interface LocalSkip {
  name: string;
  reason: string;
}

/** `GET /api/manga/local` 的响应 */
export interface MangaLocalLibraryResponse {
  /** `LOCAL_MANGA_DIR` 是否已配置 */
  configured: boolean;
  works: LocalWorkSummary[];
  total: number;
  /** 书库根目录，便于确认配置是否生效；未配置时为 null */
  root: string | null;
  /** 扫到但没收录的条目及原因 */
  skipped: LocalSkip[];
}

/** 一个可筛选标签 */
export interface MangaTagOption {
  id: string;
  /** 英文原名 */
  name: string;
  /** 中文显示名 */
  zh: string;
}

/** 标签分组（题材 / 主题 / 形式） */
export interface MangaTagGroup {
  group: 'genre' | 'theme' | 'format';
  label: string;
  tags: MangaTagOption[];
}

export interface MangaTagsResponse {
  groups: MangaTagGroup[];
}

/** 列表排序方式 */
export type MangaSortKey = 'latest' | 'popular' | 'rating' | 'newest';

export interface MangaBrowseResponse {
  items: MangaItem[];
  total: number;
  source?: MangaSourceId;
}

export interface MangaDetailResponse extends MangaItem {
  chapters: MangaChapter[];
  chapterLanguage: string;
  source?: MangaSourceId;
}

// —— 评分补全 ——

/** 评分提供方 */
export type RatingProviderId = 'tmdb' | 'douban';

/** 单条评分结果（来自 /api/rating） */
export interface RatingInfo {
  provider: RatingProviderId;
  /** 0–10 分制 */
  score: number;
  /** 评分人数 */
  votes?: number;
  /** 评分站侧标题 */
  title: string;
  year?: string;
  id?: string;
  kind?: 'movie' | 'tv';
  /** 匹配置信度 0–1（读缓存时为 1） */
  confidence: number;
}

export interface RatingsResponse {
  /** 与请求 items 一一对应；null = 未取到评分 */
  ratings: Array<RatingInfo | null>;
}

export interface RatingResponse {
  rating: RatingInfo | null;
}
