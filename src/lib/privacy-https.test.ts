import { afterEach, describe, expect, it } from 'vitest';
import {
  checkUpstreamScheme,
  isHttpsRequired,
  isPlaintextIptvAllowed,
  isPlaintextUpstream,
  isPrivateHost,
} from './privacy-https';

describe('明文上游拦截', () => {
  afterEach(() => {
    delete process.env.PRIVACY_REQUIRE_HTTPS;
    delete process.env.PRIVACY_ALLOW_PLAINTEXT_IPTV;
  });

  it('默认强制 HTTPS', () => {
    delete process.env.PRIVACY_REQUIRE_HTTPS;
    expect(isHttpsRequired()).toBe(true);
  });

  it('可用 PRIVACY_REQUIRE_HTTPS=0 显式关闭', () => {
    process.env.PRIVACY_REQUIRE_HTTPS = '0';
    expect(isHttpsRequired()).toBe(false);
    expect(checkUpstreamScheme('http://example.com/api').ok).toBe(true);
  });

  it('拒绝明文公网 HTTP', () => {
    const r = checkUpstreamScheme('http://example.com/api.php?wd=test');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('运营商');
  });

  it('放行 HTTPS', () => {
    expect(checkUpstreamScheme('https://example.com/api').ok).toBe(true);
  });

  it('放行内网自建源（不出网，运营商看不到）', () => {
    expect(checkUpstreamScheme('http://192.168.1.10/api').ok).toBe(true);
    expect(checkUpstreamScheme('http://127.0.0.1:8080/api').ok).toBe(true);
    expect(checkUpstreamScheme('http://localhost/api').ok).toBe(true);
  });

  it('识别私有地址', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('标注明文公网上游（供 UI 使用）', () => {
    expect(isPlaintextUpstream('http://example.com/a')).toBe(true);
    expect(isPlaintextUpstream('https://example.com/a')).toBe(false);
    expect(isPlaintextUpstream('http://192.168.1.1/a')).toBe(false);
  });

  describe('明文 IPTV 豁免', () => {
    it('默认放行明文 IPTV（IPTV 生态本就明文，且 URL 不含个人语义）', () => {
      delete process.env.PRIVACY_ALLOW_PLAINTEXT_IPTV;
      expect(isPlaintextIptvAllowed()).toBe(true);
    });

    it('可用 PRIVACY_ALLOW_PLAINTEXT_IPTV=0 关闭豁免，回到强制 HTTPS', () => {
      process.env.PRIVACY_ALLOW_PLAINTEXT_IPTV = '0';
      expect(isPlaintextIptvAllowed()).toBe(false);
    });

    it('豁免只作用于直播，不影响点播侧的点源拦截', () => {
      // checkUpstreamScheme 是点播侧的判定：无论 IPTV 豁免如何，它都拒绝明文
      process.env.PRIVACY_ALLOW_PLAINTEXT_IPTV = '1';
      expect(checkUpstreamScheme('http://iptv.example.com/live/a.m3u8').ok).toBe(false);
    });
  });
});
