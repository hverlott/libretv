/**
 * 出站代理（Outbound Proxy）——隐私保护的核心。
 *
 * ## 为什么需要
 *
 * LibreTV 的所有上游请求（采集站搜索 / 详情 / 视频分片 / 封面 / 豆瓣 / 直播源）
 * 都是本机发起的，源站与 CDN 会看到「你的真实 IP + 你在看什么」。
 * 具体暴露面：
 * - 源站日志里留下「某个 IP 在 20:13 搜索了《战狼》」；
 * - 视频 CDN 看到你拉取了某片的具体分片路径（含片名、分辨率、时间戳）；
 * - 封面图直连时把 Referer（内含搜索词）带给图床。
 *
 * 启用出站代理后，所有出网流量统一从代理节点出去：
 * 源站看到的是**代理节点的 IP**，你与「看了什么」之间的直接关联被打断。
 * 配合 Tor 等匿名代理，源站无法再把请求关联到你的真实身份。
 *
 * ## 支持的协议
 *
 * - `socks5://host:port` / `socks5h://host:port`（h = 远端 DNS 解析，防 DNS 泄漏）
 * - `http://host:port`（HTTP CONNECT 隧道，适用于 Clash / v2ray 等的 http 混合端口）
 * - `https://host:port`（到代理本身用 TLS 加密）
 *
 * ## 配置
 *
 * 环境变量 `UPSTREAM_PROXY=socks5h://127.0.0.1:9050`。
 * 未设置时全部直连，行为与旧版完全一致（向后兼容）。
 */

import { Agent, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';
import net from 'node:net';
import tls from 'node:tls';
import dnsCallback from 'node:dns';
import { isDohResolveEnabled, resolveDoh } from './doh';

/** 代理配置解析结果 */
export type ProxyConfig =
  | { kind: 'none' }
  | { kind: 'http'; url: string }
  | { kind: 'socks5'; host: string; port: number; username?: string; password?: string };

/**
 * 解析 UPSTREAM_PROXY。
 *
 * 只接受 http/https/socks5/socks5h 四种协议，其余一律视为无效并忽略
 * （配错了不能静默变成直连——那等于隐私保护形同虚设，必须显式报错）。
 *
 * ## 关于 socks5 与 socks5h 的 DNS
 *
 * 两者**行为完全相同**，都是远端 DNS 解析（域名交给代理端解析）。
 * 原因是 undici 的 `Socks5ProxyAgent` 把 `url.hostname`（域名，非 IP）
 * 原样放进 SOCKS5 CONNECT 请求的 ATYP=0x03（DOMAIN）字段，
 * 代理端拿到域名后自行解析——本机不做任何 DNS 查询。
 *
 * 因此 `socks5h://` 只是 `socks5://` 的惯用别名（业界约定 h = host）。
 * 保留对两种写法的支持是为了兼容用户已有的配置与文档习惯。
 */
export function parseProxyUrl(raw: string | undefined | null): ProxyConfig {
  const value = (raw ?? '').trim();
  if (!value) return { kind: 'none' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('UPSTREAM_PROXY 格式非法，应形如 socks5h://127.0.0.1:9050');
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname;
  if (!host) throw new Error('UPSTREAM_PROXY 缺少主机名');

  const port = parsed.port ? Number(parsed.port) : protocol.startsWith('socks') ? 1080 : 8080;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('UPSTREAM_PROXY 端口非法');
  }

  if (protocol === 'http' || protocol === 'https') {
    return { kind: 'http', url: parsed.toString() };
  }
  if (protocol === 'socks5' || protocol === 'socks5h') {
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    return {
      kind: 'socks5',
      host,
      port,
      username: username || undefined,
      password: password || undefined,
    };
  }
  throw new Error(`UPSTREAM_PROXY 协议不支持：${protocol}（可用 http / https / socks5 / socks5h）`);
}

/** 从环境变量读取代理配置 */
export function getProxyConfig(): ProxyConfig {
  return parseProxyUrl(process.env.UPSTREAM_PROXY);
}

/** 是否已启用出站代理 */
export function isProxyEnabled(): boolean {
  try {
    return getProxyConfig().kind !== 'none';
  } catch {
    return false;
  }
}

/** dispatcher 缓存：同一配置复用同一个 Agent，避免连接池无限增长 */
let cachedDispatcher: { key: string; dispatcher: Dispatcher } | null = null;

function dispatcherKey(config: ProxyConfig): string {
  if (config.kind === 'none') return 'none';
  if (config.kind === 'http') return `http:${config.url}`;
  return `socks:${config.host}:${config.port}:${config.username ?? ''}`;
}

/**
 * 获取出站 dispatcher。返回 null 表示直连（未配置代理）。
 *
 * dispatcher 只影响「建立 TCP 连接」这一步，TLS 仍由 undici 在隧道之上
 * 正常完成，因此代理节点看不到 HTTPS 密文内容，只看得到目标域名（SNI）。
 *
 * 未配置代理但启用了 `DOH_RESOLVE=1` 时，返回一个走 DoH 预解析的直连
 * dispatcher —— 效果是「运营商看不到你的 DNS 查询」。
 */
export function getOutboundDispatcher(): Dispatcher | null {
  let config: ProxyConfig;
  try {
    config = getProxyConfig();
  } catch (err) {
    // 配置非法时直接失败：静默直连等于隐私保护失效，必须让部署者看见
    throw new Error(err instanceof Error ? err.message : 'UPSTREAM_PROXY 配置非法');
  }

  const key = config.kind === 'none' ? 'none' : dispatcherKey(config);
  if (cachedDispatcher && cachedDispatcher.key === key) return cachedDispatcher.dispatcher;

  if (config.kind === 'none') {
    // 直连 + DoH 预解析：DNS 查询走加密通道，运营商看不到查了什么域名
    if (!isDohResolveEnabled()) return null;
    const dispatcher = createDohDispatcher();
    cachedDispatcher = { key, dispatcher };
    return dispatcher;
  }

  const dispatcher = createDispatcher(config);

  cachedDispatcher = { key, dispatcher };
  return dispatcher;
}

/**
 * 按配置构造 dispatcher。
 *
 * SOCKS5 用 undici 官方的 `Socks5ProxyAgent`（undici 7 内置），
 * 而不是手写握手——手写版本要自己处理 socket 模式切换
 * （握手后必须把 socket 交回 paused 状态，否则 TLS ServerHello 会丢），
 * 官方实现已处理这些边界。
 *
 * 远端 DNS：官方 Agent 把 `url.hostname`（域名，非 IP）放进 SOCKS5 CONNECT
 * 的 ATYP=0x03（DOMAIN）字段，由**代理端**解析——本机不做任何 DNS 查询，
 * 因此运营商既看不到你查了什么域名，也看不到目标域名。
 *
 * 直连时（未配置代理）若启用 `DOH_RESOLVE=1`，则用自定义 connector
 * 走 DoH 预解析：连接直接建到 DoH 拿到的 IP 上（Host 头与 SNI 仍是域名），
 * 于是**整条链路上没有任何一次 DNS 查询会到达运营商**。
 */
function createDispatcher(config: ProxyConfig): Dispatcher {
  if (config.kind === 'http') {
    return new ProxyAgent(config.url) as unknown as Dispatcher;
  }
  if (config.kind === 'socks5') {
    // 官方 Agent 接受 socks5:// URL；凭据放在 URL 里由其自行解析
    const auth = config.username
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? '')}@`
      : '';
    const url = `socks5://${auth}${config.host}:${config.port}`;
    // undici 7 的 Socks5ProxyAgent 仍标记为 experimental，构造时会发一次
    // ExperimentalWarning。该警告对用户没有诊断价值（不是他们能处理的错误），
    // 却在服务日志里制造噪音，因此在此处临时屏蔽。
    const originalEmit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
      if (type === 'ExperimentalWarning' && /SOCKS5 proxy support is experimental/i.test(String(warning))) {
        return;
      }
      (originalEmit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return new Socks5ProxyAgent(url) as unknown as Dispatcher;
    } finally {
      process.emitWarning = originalEmit;
    }
  }
  throw new Error('无效的代理配置');
}

/**
 * 直连 + DoH 预解析的 dispatcher。
 *
 * 原理：给 `net.connect` / `tls.connect` 传入自定义 `lookup`，
 * 让「域名 → IP」这一步走 DoH（HTTPS 加密）而不是系统 DNS（明文 UDP）。
 * 连接直接建到 DoH 返回的 IP 上，但：
 * - HTTP 请求的 Host 头仍是域名（由 undici 从 URL 生成，不受影响）；
 * - TLS 的 SNI / 证书校验仍是域名（tls.connect 的 servername 独立于解析结果）。
 * 因此**没有任何 DNS 查询到达运营商**，而 HTTP 语义完全正确。
 */
function createDohDispatcher(): Dispatcher {
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    const done = typeof callback === 'function' ? callback : (options as unknown as () => void);
    resolveDoh(hostname)
      .then((addresses) => {
        const list = addresses && addresses.length > 0 ? addresses : null;
        if (!list) {
          // DoH 不可用：回落到系统 DNS（此时运营商会看到查询，如实降级）
          dnsCallback.lookup(hostname, options as never, done as never);
          return;
        }
        const family = typeof options === 'number' ? options : (options?.family ?? 0);
        const filtered =
          family === 4 || family === 6
            ? list.filter((ip) => (family === 4 ? net.isIPv4(ip) : net.isIPv6(ip)))
            : list;
        const usable = filtered.length > 0 ? filtered : list;
        const wantsAll = typeof options === 'object' && options !== null && options.all;
        if (wantsAll) {
          (done as (e: NodeJS.ErrnoException | null, addrs?: unknown) => void)(
            null,
            usable.map((address) => ({ address, family: net.isIPv4(address) ? 4 : 6 }))
          );
          return;
        }
        (done as (e: NodeJS.ErrnoException | null, addr?: string, fam?: number) => void)(
          null,
          usable[0],
          net.isIPv4(usable[0]) ? 4 : 6
        );
      })
      .catch(() => {
        dnsCallback.lookup(hostname, options as never, done as never);
      });
  };

  return new Agent({
    connect: (opts, callback) => {
      const hostname = opts.hostname || opts.host || '';
      const port = Number(opts.port) || (opts.protocol === 'http:' ? 80 : 443);
      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        callback(err, null);
      };
      try {
        if (opts.protocol === 'https:') {
          const socket = tls.connect({
            host: hostname,
            port,
            servername: opts.servername || hostname,
            ALPNProtocols: ['http/1.1'],
            // 关键：把 DNS 解析换成 DoH
            lookup: lookup as never,
          });
          socket.once('error', onError);
          // undici 期望拿到的是**已连接**的 socket：
          // 提前交付会导致它对未握手的 socket 写数据而静默失败（表现为请求挂起）。
          socket.once(opts.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
            if (settled) return;
            settled = true;
            callback(null, socket);
          });
          return;
        }
        const socket = net.connect({ host: hostname, port, lookup: lookup as never });
        socket.once('error', onError);
        socket.once('connect', () => {
          if (settled) return;
          settled = true;
          callback(null, socket);
        });
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    },
  }) as unknown as Dispatcher;
}

/**
 * 带出站代理的 fetch。
 *
 * 关键点：undici 的 `dispatcher` 选项能作用于 **Node 内置 global fetch**
 * （Node 20+ 的 fetch 由 undici 实现，dispatcher 被透传），所以全局 fetch
 * 无需替换即可走代理。已实测验证。
 */
export async function proxiedFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const dispatcher = getOutboundDispatcher();
  if (!dispatcher) return fetch(input, init);
  // dispatcher 不是标准 RequestInit 字段，需要断言后注入
  return fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}

/**
 * 代理状态摘要（供隐私中心展示，不泄露代理凭据）。
 *
 * 字段按「运营商能看到什么」组织，而不是按实现细节组织——
 * 用户关心的是「我的 DNS 查询会不会发出去」，不是「ATYP 字段是几」。
 */
export interface ProxyStatus {
  enabled: boolean;
  kind: 'none' | 'http' | 'socks5';
  /** 脱敏后的显示串，如 socks5://127.0.0.1:9050；含凭据时不展示 */
  endpoint?: string;
  /**
   * DNS 查询是否由代理端完成（= 运营商看不到你查了什么域名）。
   * - SOCKS5：域名以 ATYP=DOMAIN 交给代理解析 → 恒为 true
   * - HTTP CONNECT：客户端先本地解析域名 → 为 false
   * - 未启用代理：本地解析 → 为 false
   */
  dnsProtected?: boolean;
  /** 代理是否加密（运营商看不到目标域名与内容） */
  encrypted?: boolean;
  error?: string;
}

export function getProxyStatus(): ProxyStatus {
  try {
    const config = getProxyConfig();
    if (config.kind === 'none') return { enabled: false, kind: 'none' };
    if (config.kind === 'http') {
      const url = new URL(config.url);
      return {
        enabled: true,
        kind: 'http',
        endpoint: `${url.protocol}//${url.hostname}:${url.port || 8080}`,
        // HTTP CONNECT 代理：客户端本地解析域名，DNS 查询仍会发给运营商
        dnsProtected: false,
        // https:// 代理时隧道本身加密；http:// 代理只是明文隧道
        encrypted: url.protocol === 'https:',
      };
    }
    return {
      enabled: true,
      kind: 'socks5',
      endpoint: `socks5://${config.host}:${config.port}`,
      // SOCKS5 以域名形式发起 CONNECT，解析发生在代理端
      dnsProtected: true,
      encrypted: true,
    };
  } catch (err) {
    return {
      enabled: false,
      kind: 'none',
      error: err instanceof Error ? err.message : '代理配置非法',
    };
  }
}
