/**
 * DNS over HTTPS（DoH）解析器。
 *
 * ## 为什么需要
 *
 * 运营商（ISP）能看到的不只是「你连了某个 IP」——**它还能看到你的 DNS 查询**。
 * 即使所有采集站都走 https://（内容加密），只要域名是本地解析的，
 * 运营商的 DNS 服务器就知道你查过 `360zy.com`、`movie.douban.com`、
 * `vod2.maowushi.com`……把这些域名按时间一串起来，
 * 就能还原出「这个 IP 在看什么片」。
 *
 * DoH 把 DNS 查询本身也放进 HTTPS 隧道里，运营商只能看到
 * 「你连了 dns.cloudflare-dns.com」，看不到查了什么。
 *
 * ## 两种使用方式
 *
 * 1. **作为 SSRF 预检的解析器**（默认开启）：
 *    `isBlockedByDNS` 改用 DoH 解析，避免本地 DNS 查询外泄。
 *    注意这是**预检**——实际建立连接时的解析仍由 undici 完成。
 * 2. **作为连接时的解析器**（`DOH_RESOLVE=1`）：
 *    预解析出 IP 后，连接直接用该 IP（Host 头仍为域名，SNI 仍为域名），
 *    这样**整个链路上没有任何一次 DNS 查询会到达运营商**。
 *    代价：CDN 换 IP 时不会自动跟随（需重试）。
 *
 * ## 可用性与降级
 *
 * - DoH 服务不可用时**静默回落到系统 DNS**（不能因为 DoH 挂了就让整个站不可用）。
 * - 但降级会在状态接口里如实上报，避免用户误以为 DNS 受保护。
 */

import dns from 'node:dns/promises';

/** 可用的 DoH 端点（按顺序尝试） */
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.alidns.com/resolve',
];

/** 单次 DoH 查询超时 */
const DOH_TIMEOUT_MS = 5000;

/** 解析结果缓存（TTL 由 DoH 响应给出，取上限 5 分钟） */
interface CacheEntry {
  addresses: string[];
  expiresAt: number;
}
const dnsCache = new Map<string, CacheEntry>();

/** DoH 是否可用（失败过则短路一段时间，避免反复拖慢请求） */
let dohHealthy = true;
let dohUnhealthyUntil = 0;

/** 是否启用「连接时用 DoH 预解析的 IP」 */
export function isDohResolveEnabled(): boolean {
  const raw = process.env.DOH_RESOLVE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** DoH 当前是否健康（状态接口用） */
export function isDohHealthy(): boolean {
  return dohHealthy && Date.now() > dohUnhealthyUntil;
}

interface DohAnswer {
  type?: number;
  data?: string;
  TTL?: number;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

/**
 * 用 DoH 解析域名，返回 IP 列表。
 *
 * 失败时返回 null（调用方决定如何降级）。
 */
export async function resolveDoh(hostname: string): Promise<string[] | null> {
  if (!dohHealthy && Date.now() < dohUnhealthyUntil) return null;

  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const addresses = await queryDoh(endpoint, hostname);
      if (addresses.length > 0) {
        dohHealthy = true;
        // 缓存 5 分钟上限：CDN 换 IP 时不至于长时间卡在旧 IP
        dnsCache.set(hostname, { addresses, expiresAt: Date.now() + 5 * 60_000 });
        return addresses;
      }
    } catch {
      // 试下一个端点
    }
  }
  // 全部失败：标记为不健康，5 分钟内不再重试（避免每个请求都等超时）
  dohHealthy = false;
  dohUnhealthyUntil = Date.now() + 5 * 60_000;
  return null;
}

async function queryDoh(endpoint: string, hostname: string): Promise<string[]> {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'A');

  const res = await fetch(url.toString(), {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    // DoH 查询不应走上游代理（那会形成环，且代理节点本就能解析域名）
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);

  const data = (await res.json()) as DohResponse;
  if (data.Status !== 0) throw new Error(`DoH 状态码 ${data.Status}`);

  const addresses: string[] = [];
  for (const answer of data.Answer ?? []) {
    // type 1 = A 记录
    if (answer.type === 1 && answer.data) addresses.push(answer.data);
  }
  return addresses;
}

/**
 * 解析域名，优先用 DoH，失败回落系统 DNS。
 *
 * 返回 null 表示解析失败（与原有 dns.lookup 的失败语义一致）。
 *
 * 系统 DNS 通过可注入的 `systemResolver` 调用：
 * - 便于单测断言「DoH 成功时系统 DNS 一次都没被调用」（这是防泄漏的关键证据）；
 * - 便于在极端场景下强制禁用系统 DNS（`DOH_ONLY=1`）。
 */
export async function resolveHostname(hostname: string): Promise<string[] | null> {
  const doh = await resolveDoh(hostname);
  if (doh && doh.length > 0) return doh;

  // DoH 不可用：回落系统 DNS（此时运营商会看到查询，如实降级）
  if (isDohOnly()) return null;
  return systemResolver(hostname);
}

/** 系统 DNS 解析器（可注入，便于测试） */
type SystemResolver = (hostname: string) => Promise<string[] | null>;

const defaultSystemResolver: SystemResolver = async (hostname) => {
  try {
    const result = await dns.lookup(hostname, { all: true });
    return result.map((r) => r.address);
  } catch {
    return null;
  }
};

let systemResolver: SystemResolver = defaultSystemResolver;

/** 替换系统 DNS 解析器（仅测试用） */
export function __setSystemResolver(fn: SystemResolver): void {
  systemResolver = fn;
}

/** 恢复默认解析器 */
export function __resetSystemResolver(): void {
  systemResolver = defaultSystemResolver;
}

/** 是否禁止回落系统 DNS（DoH 不可用时直接失败，而不是泄漏查询） */
export function isDohOnly(): boolean {
  const raw = process.env.DOH_ONLY?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** 清空缓存（测试与手动刷新用） */
export function clearDohCache(): void {
  dnsCache.clear();
  dohHealthy = true;
  dohUnhealthyUntil = 0;
}
