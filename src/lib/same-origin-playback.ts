/**
 * 播放地址同源化（Same-Origin Playback）。
 *
 * ## 为什么必须做
 *
 * 详情接口原本把上游的 m3u8 直链原样返回给浏览器，播放器直接
 * `hls.loadSource(上游地址)`。这意味着：
 *
 * 1. **浏览器直连上游 CDN**，视频源看到的是**用户的真实 IP**（不是本机代理的 IP）；
 * 2. 分片请求路径里常含片名、分辨率、采集站标识（`/2024/战狼/1080P/xxx.ts`），
 *    CDN 侧日志里就是一条条「某人在看什么」的记录；
 * 3. 浏览器的 Referer 头会把本地页面地址带给上游。
 *
 * 改成同源代理地址后，浏览器只与 `localhost` 通信：
 * - 上游看到的是**本机（服务进程）**的连接，浏览器 IP 不再外泄；
 * - 配合 `UPSTREAM_PROXY`（Tor / SOCKS5），连本机 IP 也不外泄；
 * - 分片路径、Referer 全部留在本机，不进上游日志。
 *
 * ## 兼容性
 *
 * 代理形式（`/api/proxy?url=…`）是播放器**本就支持**的一等公民：
 * 直播一直走 `/api/live/stream?url=…`，点播在直连失败时也会自动降级到代理。
 * 因此这里默认开启同源化，不引入新的播放路径。
 */

/** 点播代理地址基座（与 m3u8.ts 的 PROXY_BASE 保持一致） */
const PROXY_BASE = '/api/proxy?url=';

/** 已经是本站代理地址的不再二次包装 */
function isProxied(url: string): boolean {
  return url.startsWith('/api/proxy') || url.startsWith('/api/live/stream');
}

/**
 * 把单个上游地址改写为同源代理地址。
 *
 * 非 http(s) 协议（如 data:、blob:）保持原样——它们本就不出网。
 * 已经是代理形式的保持原样，避免出现双重代理。
 */
export function toSameOriginPlayback(url: string): string {
  if (!url) return url;
  if (isProxied(url)) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  return PROXY_BASE + encodeURIComponent(url);
}

/**
 * 批量改写详情里的剧集地址。
 *
 * 保留原始地址到 `rawEpisodes` 的对应关系由调用方按需处理；
 * 本函数只做纯映射，便于单测。
 */
export function toSameOriginEpisodes(episodes: string[]): string[] {
  return episodes.map((ep) => toSameOriginPlayback(ep));
}

/**
 * 还原为上游原始地址。
 *
 * 服务端下载（server-download）需要拿到**原始**上游地址：
 * 它在服务端发起请求，已经处于代理保护之下，无需再套一层本站代理
 * （套了反而会让服务端请求自己的 HTTP 接口，多一跳且可能死锁）。
 */
export function toUpstreamUrl(url: string): string {
  if (!url.startsWith('/api/proxy?url=')) return url;
  const raw = url.slice('/api/proxy?url='.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return url;
  }
}
