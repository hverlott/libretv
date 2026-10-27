import { afterEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import {
  __resetSystemResolver,
  __setSystemResolver,
  clearDohCache,
  isDohHealthy,
  isDohOnly,
  resolveDoh,
  resolveHostname,
} from './doh';

describe('DoH 解析', () => {
  afterEach(() => {
    __resetSystemResolver();
    clearDohCache();
    delete process.env.DOH_ONLY;
  });

  it('能通过 DoH 解析真实域名', async () => {
    clearDohCache();
    const addrs = await resolveDoh('www.baidu.com');
    expect(addrs).not.toBeNull();
    expect(addrs!.length).toBeGreaterThan(0);
    expect(isDohHealthy()).toBe(true);
  });

  it('不存在的域名返回 null', async () => {
    clearDohCache();
    const addrs = await resolveDoh('this-domain-should-not-exist-xyz123.test');
    expect(addrs).toBeNull();
  });

  it('DoH 成功时完全不调用系统 DNS（防泄漏的关键）', async () => {
    clearDohCache();
    let systemCalled = 0;
    __setSystemResolver(async () => {
      systemCalled += 1;
      return ['1.2.3.4'];
    });

    const addrs = await resolveHostname('www.baidu.com');
    expect(addrs).not.toBeNull();
    // 系统 DNS 一次都没被调用 → 运营商看不到 DNS 查询
    expect(systemCalled).toBe(0);
  });

  it('DoH 不可用时回落系统 DNS', async () => {
    clearDohCache();
    let systemCalled = 0;
    __setSystemResolver(async () => {
      systemCalled += 1;
      return ['1.2.3.4'];
    });

    // 不存在的域名：DoH 失败 → 回落
    const addrs = await resolveHostname('nonexistent-domain-xyz-987.test');
    expect(systemCalled).toBeGreaterThan(0);
    expect(addrs).toEqual(['1.2.3.4']);
  });


  it('DoH 解析期间不发出任何 UDP/53 查询（运营商侧的直接证据）', async () => {
    const queries: string[] = [];
    const origSend = dgram.Socket.prototype.send;
    // 劫持 UDP 发送以观测是否有明文 DNS 查询离开本机
    dgram.Socket.prototype.send = function (...args: unknown[]) {
      try {
        const buf = Buffer.isBuffer(args[0]) ? args[0] : (args[0] as { buffer?: Buffer })?.buffer;
        // DNS 查询头部：ID(2) + flags(2) + QDCOUNT(2)，QDCOUNT>0 才是查询
        if (buf && buf.length > 12 && buf.readUInt16BE(2) > 0) {
          queries.push(buf.subarray(12).toString('utf8').slice(0, 40));
        }
      } catch {
        /* 忽略 */
      }
      return origSend.apply(this, args as never);
    };

    try {
      const addrs = await resolveDoh('www.baidu.com');
      await new Promise((r) => setTimeout(r, 500));
      expect(addrs).not.toBeNull();
      // 一个明文 DNS 查询都没发出 → 运营商的 DNS 服务器看不到这次查询
      expect(queries).toEqual([]);
    } finally {
      dgram.Socket.prototype.send = origSend;
    }
  });

  it('DOH_ONLY=1 时不回落系统 DNS（宁可失败也不泄漏）', async () => {
    clearDohCache();
    process.env.DOH_ONLY = '1';
    let systemCalled = 0;
    __setSystemResolver(async () => {
      systemCalled += 1;
      return ['1.2.3.4'];
    });

    const addrs = await resolveHostname('nonexistent-domain-xyz-987.test');
    expect(systemCalled).toBe(0);
    expect(addrs).toBeNull();
    expect(isDohOnly()).toBe(true);
  });
});
