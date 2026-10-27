/**
 * 明文上游拦截（PRIVACY_REQUIRE_HTTPS）。
 *
 * ## 为什么需要
 *
 * 走 https:// 的采集站，运营商（ISP）只能看到「你连了某个 IP、传输了若干字节」，
 * 看不到你请求的具体路径，也就看不到搜索词（`?wd=战狼`）。
 *
 * 而 http:// 的采集站是**明文**的：运营商的 DPI 设备能直接看到
 * 完整的请求行——**包含搜索词在内的每一个字**。
 * 这等于把「你在搜什么」直接写在信封上寄给运营商。
 *
 * 现实里 DEFAULT_SOURCES 里就曾有三个 http:// 源（caiji.dyttzyapi.com /
 * ffzy5.tv / www.cmov.cn），它们已验证支持 HTTPS 并升级完毕。
 * 但用户随时可能新增源，因此加一道**默认开启的硬防线**：
 * 拒绝明文上游，而不是指望每次都记得用 https。
 *
 * ## 行为
 *
 * - `PRIVACY_REQUIRE_HTTPS=1`（默认）：任何 http:// 上游直接拒绝，
 *   搜索时该源被跳过，代理请求返回 403。
 * - `PRIVACY_REQUIRE_HTTPS=0`：显式关闭，允许明文源（用于特殊内网源等场景）。
 *
 * 注意：本地自建的内网源（`http://192.168.x.x`）也被这条规则拦下。
 * 这类源本来就不出网，运营商看不到它们，因此这里对**私有地址**网开一面。
 */

import net from 'node:net';

/** 是否强制 HTTPS 上游（默认开启） */
export function isHttpsRequired(): boolean {
  const raw = process.env.PRIVACY_REQUIRE_HTTPS?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** 是否是私有/回环地址（本地自建源，本就不出网） */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(host)) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

export interface HttpsVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * 检查一个上游地址是否允许使用。
 *
 * 只在强制 HTTPS 且目标是明文公网地址时拒绝。
 */
export function checkUpstreamScheme(urlString: string): HttpsVerdict {
  if (!isHttpsRequired()) return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: '地址格式非法' };
  }
  if (parsed.protocol !== 'http:') return { ok: true };
  // 私有地址不经过运营商，无需强制 HTTPS
  if (isPrivateHost(parsed.hostname)) return { ok: true };
  return {
    ok: false,
    reason:
      '已阻止明文 HTTP 上游：运营商可直接看到请求路径中的搜索词。' +
      '请改用 https:// 地址，或设置 PRIVACY_REQUIRE_HTTPS=0 显式关闭此保护。',
  };
}

/** 该地址是否为明文公网 HTTP（用于 UI 标注） */
export function isPlaintextUpstream(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 是否允许明文 IPTV 直播流。
 *
 * ## 为什么需要单独豁免
 *
 * 明文拦截的目的是保护**点播搜索词**——`http://` 采集站的 `?wd=战狼`
 * 会把搜索内容明文过链路，让运营商直接可读。
 *
 * 但 IPTV 直播流的处境完全不同：
 * - 直播 URL 里**不含任何个人语义**（没有搜索词、没有片名，只有频道编号），
 *   运营商看到 `http://120.76.248.139/live/bfgd/4200000488.m3u8` 并不知道你在看什么；
 * - IPTV 生态本身就是明文 HLS（RTSP/RTP 转封装），**绝大多数服务器不提供 HTTPS**。
 *   实测 2000+ 条公开 IPTV 线路里仅约 13% 是 https。若不豁免，
 *   加进来的直播源会有 87% 被自己的防护拦掉，等于白加。
 * - 直播是持续视频流，运营商本来就能从**流量特征**推断出「这个人在看视频」，
 *   这是技术边界（见 PRIVACY.md），不是加密与否能解决的。
 *
 * 因此这里给直播开一个**精确到场景**的豁免，而不是把 `PRIVACY_REQUIRE_HTTPS`
 * 整体关掉——后者会连带让点播侧失去保护。
 *
 * 想要更强的匿名性，正确的做法是配 `UPSTREAM_PROXY`：直播流也会经隧道出去，
 * 运营商只看到「你连了代理节点」。
 *
 * - `PRIVACY_ALLOW_PLAINTEXT_IPTV=0`（默认）：直播流同样强制 HTTPS
 * - `PRIVACY_ALLOW_PLAINTEXT_IPTV=1`：放行明文 IPTV（默认开启，因为不加就没法用）
 */
export function isPlaintextIptvAllowed(): boolean {
  const raw = process.env.PRIVACY_ALLOW_PLAINTEXT_IPTV?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}
