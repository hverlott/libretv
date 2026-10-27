export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 停用时长的可读文案：不足 1 小时按分钟，超过按小时（按剩余时间展示时向上取整） */
export function formatDisableTtl(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
}

/**
 * 封面图加载地址：direct 直连 / proxy 内置代理 / custom 自定义模板（{url} 占位符或直接拼接）。
 * 默认 proxy（内置代理），规避豆瓣防盗链与部分采集站图床直连失败。
 * 代理走查询串形式（/api/proxy?url=…）：路径里的 %2F 会被 EdgeOne 等网关
 * 在路由匹配前解码成 /，查询串不受影响，全平台行为一致。
 */
export function buildImageUrl(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string | undefined {
  if (!url) return undefined;
  if (mode === 'proxy') return `/api/proxy?url=${encodeURIComponent(url)}`;
  if (mode === 'custom' && customTemplate) {
    return customTemplate.includes('{url}')
      ? customTemplate.replace('{url}', encodeURIComponent(url))
      : customTemplate + encodeURIComponent(url);
  }
  return url;
}

/**
 * 封面图降级候选链，各模式首选地址失败后由 SmartImage 按序回退（onError 逐级尝试）：
 * - direct 模式：原站直连 → cmliussss 公共镜像（腾讯 / 阿里，仅豆瓣图）→ 内置代理。
 *   doubanio 反爬对外域与空 Referer 分别返回 403 / 418，纯前端无法绕过；
 *   公共镜像实测直连可用，置于自家代理之前以节省服务器流量。
 * - proxy 模式：内置代理 → 公共镜像（仅豆瓣图）→ 原站直连。
 *   代理是全站封面的公共依赖，不能单点——代理故障时自动落到直连/镜像。
 * - custom 模式为单一地址：模板错误应显式暴露，不被静默回退掩盖。
 */
export function buildImageCandidates(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string[] {
  const built = buildImageUrl(url, mode, customTemplate);
  if (!built || !url) return [];
  const mirrors = url.includes('doubanio.com')
    ? [
        url.replace(/img\d+\.doubanio\.com/g, 'img.doubanio.cmliussss.net'),
        url.replace(/img\d+\.doubanio\.com/g, 'img.doubanio.cmliussss.com'),
      ]
    : [];
  if (mode === 'proxy') {
    return [...new Set([built, ...mirrors, url])];
  }
  if (mode !== 'direct') return [built];
  return [...new Set([built, ...mirrors, `/api/proxy?url=${encodeURIComponent(url)}`])];
}

export function validateSourceUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url);
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 为分享链接等场景构造观看页 URL。
 *
 * ## 隐私设计：片名与直链放 URL 片段（#）而非查询串（?）
 *
 * 查询串里的内容会出现在三处：
 * - 浏览器历史记录（本地明文，且部分浏览器的「历史同步」会上传云端）；
 * - 服务端 / 反向代理的访问日志（`GET /watch?title=战狼` 一行一个片名）；
 * - 页面发往第三方的 Referer 头。
 *
 * 片段（`#` 之后）**不会**被发送给服务器，也不会出现在 Referer 里，
 * 只有浏览器自己会读。因此把片名、直链放片段，服务器与上游都看不到。
 *
 * `source` / `id` / `index` 留在查询串：它们是路由定位所必需，
 * 且 vodId 是不含语义的编号，单独出现无法反推片名。
 *
 * ## 客户端基路径
 *
 * `basePath` 用于客户端（桌面客户端把 LibreTV 挂在 `/app/` 前缀下）：
 * 不带前缀时链接会指向控制面板自己的首页，表现为「点了没反应」。
 */
export function buildWatchUrl(params: {
  sourceKey: string;
  vodId?: string;
  index?: number;
  title?: string;
  episodeUrl?: string;
  sourceUrl?: string;
  detail?: string;
  /** 客户端基路径（如 '/app'）；直连部署留空 */
  basePath?: string;
}): string {
  const sp = new URLSearchParams();
  sp.set('source', params.sourceKey);
  if (params.vodId) sp.set('id', params.vodId);
  if (typeof params.index === 'number') sp.set('index', String(params.index));

  // 敏感参数走片段
  const frag = new URLSearchParams();
  if (params.title) frag.set('title', params.title);
  if (params.episodeUrl) frag.set('url', params.episodeUrl);
  if (params.sourceUrl) frag.set('sourceUrl', params.sourceUrl);
  if (params.detail) frag.set('detail', params.detail);

  const watchPath = params.basePath ? `${params.basePath}/watch` : '/watch';
  const base = `${watchPath}?${sp.toString()}`;
  const fragStr = frag.toString();
  return fragStr ? `${base}#${fragStr}` : base;
}

/**
 * 从 URL 片段解析敏感参数（title / url / sourceUrl / detail）。
 *
 * 播放页在客户端挂载后读取 `location.hash`——服务端渲染阶段拿不到片段，
 * 因此首帧先用占位标题，详情到达后再回填。
 */
export function parseWatchFragment(hash: string): {
  title?: string;
  episodeUrl?: string;
  sourceUrl?: string;
  detail?: string;
} {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return {};
  try {
    const sp = new URLSearchParams(raw);
    const title = sp.get('title') || undefined;
    const episodeUrl = sp.get('url') || undefined;
    const sourceUrl = sp.get('sourceUrl') || undefined;
    const detail = sp.get('detail') || undefined;
    return { title, episodeUrl, sourceUrl, detail };
  } catch {
    return {};
  }
}
