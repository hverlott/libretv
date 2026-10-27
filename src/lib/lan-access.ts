import os from 'node:os';

/**
 * 局域网访问：绑定地址解析、网卡地址枚举、弱密码判定。
 *
 * ## 为什么默认不开放
 *
 * `next start` 不传 `-H` 时默认绑 `0.0.0.0`，等于**同网段的任何设备**都能访问：
 * 咖啡厅 WiFi、公司网、酒店路由下面的陌生设备，看到的都是你的片名列表，
 * 密码被猜到后还能完整操作账号。因此本项目的默认是 `127.0.0.1`（仅本机）。
 *
 * 要让手机/电视用，显式打开 `LAN_ACCESS=1`（或直接写 `BIND_HOST=0.0.0.0`），
 * 代价是上面那段风险——所以这里同时提供弱密码判定，在界面上明确告警。
 *
 * ## 为什么不只是一个布尔
 *
 * 绑定 `0.0.0.0` 之后用户需要知道「到底该在手机上输入哪个地址」，
 * 而一台机器可能同时有有线、无线、虚拟机、Docker 多个网卡。
 * 所以这里把可用地址一并算出来，供启动日志和系统页直接展示。
 */

/** 常见弱口令：命中即告警（不阻止，用户可能在自己信任的网段里自用） */
const WEAK_PASSWORDS = new Set([
  'libretv',
  '123456',
  '12345678',
  '123456789',
  'password',
  'admin',
  'admin123',
  'qwerty',
  'abc123',
  '111111',
  '000000',
  '888888',
  '666666',
  'iloveyou',
  'test',
  'guest',
]);

/** 局域网开放时建议的最短密码长度 */
export const MIN_SAFE_PASSWORD_LENGTH = 8;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface LanAddress {
  /** IPv4 地址，如 192.168.31.100 */
  address: string;
  /** 网卡名，如「以太网」「WLAN」 */
  iface: string;
}

export interface LanInfo {
  /** 是否允许本机以外的设备访问 */
  enabled: boolean;
  /** 实际绑定地址（0.0.0.0 / 127.0.0.1 / 具体网卡 IP） */
  bindHost: string;
  port: number;
  /** 局域网内可直接使用的访问地址 */
  addresses: string[];
  /** 拼好的完整 URL（带端口），手机直接输入即可 */
  urls: string[];
  /** 是否已配置访问密码（未配置 = 全站无鉴权，开局域网等于公开） */
  passwordConfigured: boolean;
  /** 密码是否偏弱（仅在内网开放时才有安全意义） */
  passwordWeak: boolean;
}

/**
 * 解析应绑定的地址。
 *
 * 优先级：`BIND_HOST` 显式指定 > `LAN_ACCESS=1` > 仅本机。
 * 之所以保留 `BIND_HOST` 的优先级，是为了「绑到某一张特定网卡」这种更精细的需求。
 */
export function resolveBindHost(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.BIND_HOST || '').trim();
  if (explicit) {
    const lowered = explicit.toLowerCase();
    if (lowered === 'localhost') return '127.0.0.1';
    return explicit;
  }
  const lan = (env.LAN_ACCESS || '').trim().toLowerCase();
  if (lan === '1' || lan === 'true' || lan === 'yes' || lan === 'on') return '0.0.0.0';

  /**
   * Docker 场景：镜像里 `ENV HOSTNAME=0.0.0.0`，Next 用它决定绑定地址。
   * 不认这一项的话，容器里明明对外可达，系统页却显示「仅本机可访问」——
   * 与实际相反，比不显示更糟。只接受 IP 字面量：
   * Docker 默认会把 HOSTNAME 设成容器短 ID（如 3f2a1b6c），那种值不能当地址用。
   */
  const hostname = (env.HOSTNAME || '').trim();
  if (hostname && (hostname === '::' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname))) {
    return hostname;
  }

  return '127.0.0.1';
}

/** 该绑定地址是否会让本机以外的设备也能连接 */
export function isExposed(bindHost: string): boolean {
  const host = (bindHost || '').trim().toLowerCase();
  if (!host) return false;
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return true;
  return !LOOPBACK_HOSTS.has(host);
}

/**
 * 枚举可用于局域网访问的 IPv4 地址。
 *
 * 过滤掉：内部地址（回环）、IPv6（手机上输入体验太差，且多数家用路由不派发）、
 * 以及 169.254.x.x（APIPA，网线没拿到 DHCP 时系统自己编的地址，连不通别的主机）。
 *
 * `ifaces` 可注入，单测不依赖真实网卡。
 */
export function collectLanAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push({ address: info.address, iface });
    }
  }
  // 私有网段（192.168 / 10. / 172.16-31）优先：那才是家里/公司的局域网
  const isPrivate = (ip: string) =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return out.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
}

/** 弱密码判定：太短，或命中常见口令表 */
export function isWeakPassword(password: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const pw = password ?? env.PASSWORD ?? '';
  if (!pw) return true;
  if (pw.length < MIN_SAFE_PASSWORD_LENGTH) return true;
  return WEAK_PASSWORDS.has(pw.trim().toLowerCase());
}

/** 汇总一份给界面/日志用的局域网信息 */
export function getLanInfo(
  port: number,
  options: {
    env?: Record<string, string | undefined>;
    ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  } = {}
): LanInfo {
  const env = options.env ?? process.env;
  const bindHost = resolveBindHost(env);
  const enabled = isExposed(bindHost);
  const password = env.PASSWORD ?? '';

  // 只有真的对外开放时才给出地址：没开放就不存在「可访问的局域网地址」，
  // 返回一堆连不上的 IP 只会让人误以为已经能用。
  // 「配置已开启但还没重启」的预览由调用方用目标配置再算一份（见 /api/system）。
  const all = collectLanAddresses(options.ifaces);
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::';
  const addresses = enabled ? (wildcard ? all.map((entry) => entry.address) : [bindHost]) : [];

  return {
    enabled,
    bindHost,
    port,
    addresses,
    urls: addresses.map((ip) => `http://${ip}:${port}`),
    passwordConfigured: password.length > 0,
    passwordWeak: isWeakPassword(password, env),
  };
}
