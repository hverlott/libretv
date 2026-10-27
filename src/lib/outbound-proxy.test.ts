import { describe, expect, it } from 'vitest';
import { getOutboundDispatcher, getProxyStatus, isProxyEnabled } from './outbound-proxy';

describe('出站代理', () => {
  it('未配置代理时 dispatcher 为 null（直连）', () => {
    delete process.env.UPSTREAM_PROXY;
    expect(getOutboundDispatcher()).toBeNull();
    expect(isProxyEnabled()).toBe(false);
    expect(getProxyStatus()).toEqual({ enabled: false, kind: 'none' });
  });

  it('配置代理后返回 dispatcher', () => {
    process.env.UPSTREAM_PROXY = 'socks5h://127.0.0.1:9050';
    try {
      const d = getOutboundDispatcher();
      expect(d).not.toBeNull();
      expect(isProxyEnabled()).toBe(true);
      const status = getProxyStatus();
      expect(status.enabled).toBe(true);
      expect(status.kind).toBe('socks5');
      // SOCKS5 由代理端解析域名 → DNS 查询不经过运营商
      expect(status.dnsProtected).toBe(true);
      // 状态摘要不得包含凭据
      expect(status.endpoint).toBe('socks5://127.0.0.1:9050');
    } finally {
      delete process.env.UPSTREAM_PROXY;
    }
  });

  it('相同配置复用同一个 dispatcher（连接池不膨胀）', () => {
    process.env.UPSTREAM_PROXY = 'socks5://127.0.0.1:1080';
    try {
      const a = getOutboundDispatcher();
      const b = getOutboundDispatcher();
      expect(a).toBe(b);
    } finally {
      delete process.env.UPSTREAM_PROXY;
    }
  });

  it('配置非法时抛错而非静默直连', () => {
    process.env.UPSTREAM_PROXY = 'ftp://127.0.0.1:21';
    try {
      expect(() => getOutboundDispatcher()).toThrow();
      // 状态接口给出错误信息而不是假装正常
      expect(getProxyStatus().error).toBeTruthy();
      expect(getProxyStatus().enabled).toBe(false);
    } finally {
      delete process.env.UPSTREAM_PROXY;
    }
  });

  it('http 代理可用', () => {
    process.env.UPSTREAM_PROXY = 'http://127.0.0.1:7890';
    try {
      expect(getOutboundDispatcher()).not.toBeNull();
      const status = getProxyStatus();
      expect(status.kind).toBe('http');
      // HTTP CONNECT 代理：客户端本地解析域名 → DNS 查询仍会发给运营商
      expect(status.dnsProtected).toBe(false);
    } finally {
      delete process.env.UPSTREAM_PROXY;
    }
  });

  it('带凭据的 socks5 状态摘要不含密码', () => {
    process.env.UPSTREAM_PROXY = 'socks5://user:secretpw@1.2.3.4:1080';
    try {
      const status = getProxyStatus();
      expect(status.endpoint).toBe('socks5://1.2.3.4:1080');
      expect(status.endpoint).not.toContain('secretpw');
    } finally {
      delete process.env.UPSTREAM_PROXY;
    }
  });
});
