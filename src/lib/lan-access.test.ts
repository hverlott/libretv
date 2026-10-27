import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  MIN_SAFE_PASSWORD_LENGTH,
  collectLanAddresses,
  getLanInfo,
  isExposed,
  isWeakPassword,
  resolveBindHost,
} from './lan-access';

/** 构造一张假网卡表，避免单测依赖真实机器的网络环境 */
function info(address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
    // IPv6 的必填字段；IPv4 下用不到，填 0 即可
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

function ifacesFrom(
  entries: Array<[string, string, ('IPv4' | 'IPv6')?, boolean?]>
): NodeJS.Dict<NetworkInterfaceInfo[]> {
  const out: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
  for (const [address, name, family = 'IPv4', internal = false] of entries) {
    out[name] = [...(out[name] ?? []), info(address, family, internal)];
  }
  return out;
}

describe('resolveBindHost', () => {
  it('默认只监听本机', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ LAN_ACCESS: '0' })).toBe('127.0.0.1');
  });

  it('LAN_ACCESS 的多种真值写法都认', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveBindHost({ LAN_ACCESS: value })).toBe('0.0.0.0');
    }
  });

  it('BIND_HOST 优先级高于 LAN_ACCESS（支持只绑某张网卡）', () => {
    expect(resolveBindHost({ LAN_ACCESS: '1', BIND_HOST: '192.168.31.100' })).toBe('192.168.31.100');
    expect(resolveBindHost({ LAN_ACCESS: '1', BIND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('localhost 归一成 127.0.0.1', () => {
    expect(resolveBindHost({ BIND_HOST: 'localhost' })).toBe('127.0.0.1');
    expect(resolveBindHost({ BIND_HOST: 'LocalHost' })).toBe('127.0.0.1');
  });

  it('空白值当作未配置', () => {
    expect(resolveBindHost({ BIND_HOST: '   ', LAN_ACCESS: '1' })).toBe('0.0.0.0');
  });

  it('Docker 里认 HOSTNAME（镜像内 ENV HOSTNAME=0.0.0.0）', () => {
    expect(resolveBindHost({ HOSTNAME: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ HOSTNAME: '192.168.1.5' })).toBe('192.168.1.5');
  });

  it('HOSTNAME 是容器 ID 时不当地址用', () => {
    // Docker 默认把 HOSTNAME 设成容器短 ID，认了它会拼出 http://3f2a1b6c:8080 这种鬼地址
    expect(resolveBindHost({ HOSTNAME: '3f2a1b6c9d7e' })).toBe('127.0.0.1');
    expect(resolveBindHost({ HOSTNAME: 'my-pc' })).toBe('127.0.0.1');
  });

  it('BIND_HOST 与 LAN_ACCESS 都优先于 HOSTNAME', () => {
    expect(resolveBindHost({ HOSTNAME: '0.0.0.0', BIND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveBindHost({ HOSTNAME: '192.168.1.5', LAN_ACCESS: '1' })).toBe('0.0.0.0');
  });
});

describe('isExposed', () => {
  it('通配与具体网卡 IP 算对外开放', () => {
    expect(isExposed('0.0.0.0')).toBe(true);
    expect(isExposed('::')).toBe(true);
    expect(isExposed('192.168.1.5')).toBe(true);
    expect(isExposed('10.0.0.2')).toBe(true);
  });

  it('回环与空值不算', () => {
    expect(isExposed('127.0.0.1')).toBe(false);
    expect(isExposed('localhost')).toBe(false);
    expect(isExposed('::1')).toBe(false);
    expect(isExposed('')).toBe(false);
  });
});

describe('collectLanAddresses', () => {
  it('过滤 IPv6、回环、APIPA', () => {
    const list = collectLanAddresses(
      ifacesFrom([
        ['127.0.0.1', 'Loopback', 'IPv4', true],
        ['192.168.31.100', 'WLAN'],
        ['fe80::1', 'WLAN', 'IPv6'],
        ['169.254.10.20', '以太网'],
        ['10.1.2.3', '以太网'],
      ])
    );
    expect(list.map((x) => x.address)).toEqual(['192.168.31.100', '10.1.2.3']);
  });

  it('私有网段排在前面（家里/公司的地址更可能是用户要的那一个）', () => {
    const list = collectLanAddresses(
      ifacesFrom([
        ['100.64.0.5', 'Tailscale'],
        ['192.168.1.20', 'WLAN'],
        ['172.20.10.1', 'vEthernet'],
      ])
    );
    expect(list[0]?.address).toBe('192.168.1.20');
    expect(list.at(-1)?.address).toBe('100.64.0.5');
  });

  it('网卡为空时不抛错', () => {
    expect(collectLanAddresses({})).toEqual([]);
  });
});

describe('isWeakPassword', () => {
  it('未配置密码算弱（等于没有防线）', () => {
    expect(isWeakPassword('', {})).toBe(true);
    expect(isWeakPassword(undefined, {})).toBe(true);
  });

  it('太短算弱', () => {
    expect(isWeakPassword('abc123', {})).toBe(true);
    expect(isWeakPassword('a'.repeat(MIN_SAFE_PASSWORD_LENGTH - 1), {})).toBe(true);
  });

  it('常见口令算弱（大小写与空格不敏感）', () => {
    expect(isWeakPassword('libretv', {})).toBe(true);
    expect(isWeakPassword('  Libretv  ', {})).toBe(true);
    expect(isWeakPassword('12345678', {})).toBe(true);
    expect(isWeakPassword('PASSWORD', {})).toBe(true);
  });

  it('够长的自有口令算合格', () => {
    expect(isWeakPassword('Xk7#pQ2m-Lmz', {})).toBe(false);
    expect(isWeakPassword('我的私有口令2026', {})).toBe(false);
  });

  it('不传参时读 PASSWORD', () => {
    expect(isWeakPassword(undefined, { PASSWORD: 'libretv' })).toBe(true);
    expect(isWeakPassword(undefined, { PASSWORD: 'StrongPass123' })).toBe(false);
  });
});

describe('getLanInfo', () => {
  const fakeIfaces = ifacesFrom([
    ['192.168.31.100', 'WLAN'],
    ['10.8.0.2', 'vEthernet'],
  ]);

  it('未开启时不暴露任何地址', () => {
    const info = getLanInfo(8080, { env: { PASSWORD: 'StrongPass123' }, ifaces: fakeIfaces });
    expect(info.enabled).toBe(false);
    expect(info.bindHost).toBe('127.0.0.1');
    expect(info.addresses).toEqual([]);
    expect(info.urls).toEqual([]);
  });

  it('开启后拼出可直接输入的 URL', () => {
    const info = getLanInfo(8080, {
      env: { LAN_ACCESS: '1', PASSWORD: 'StrongPass123' },
      ifaces: fakeIfaces,
    });
    expect(info.enabled).toBe(true);
    expect(info.urls).toEqual(['http://192.168.31.100:8080', 'http://10.8.0.2:8080']);
  });

  it('指定具体 IP 时只列那一个', () => {
    const info = getLanInfo(9000, {
      env: { BIND_HOST: '192.168.31.100', PASSWORD: 'StrongPass123' },
      ifaces: fakeIfaces,
    });
    expect(info.urls).toEqual(['http://192.168.31.100:9000']);
  });

  it('指定的 IP 不在网卡上时也照样列出来（Docker 网桥等场景）', () => {
    const info = getLanInfo(8080, {
      env: { BIND_HOST: '172.17.0.1', PASSWORD: 'StrongPass123' },
      ifaces: fakeIfaces,
    });
    expect(info.urls).toEqual(['http://172.17.0.1:8080']);
  });

  it('同时给出密码是否配置与是否偏弱', () => {
    const weak = getLanInfo(8080, { env: { LAN_ACCESS: '1', PASSWORD: 'libretv' }, ifaces: fakeIfaces });
    expect(weak.passwordConfigured).toBe(true);
    expect(weak.passwordWeak).toBe(true);

    const strong = getLanInfo(8080, { env: { LAN_ACCESS: '1', PASSWORD: 'StrongPass123' }, ifaces: fakeIfaces });
    expect(strong.passwordWeak).toBe(false);

    const none = getLanInfo(8080, { env: { LAN_ACCESS: '1' }, ifaces: fakeIfaces });
    expect(none.passwordConfigured).toBe(false);
    expect(none.passwordWeak).toBe(true);
  });
});
