import { describe, expect, it } from 'vitest';
import { parseProxyUrl } from './outbound-proxy';
import { toSameOriginPlayback, toSameOriginEpisodes, toUpstreamUrl } from './same-origin-playback';
import { parseWatchFragment, buildWatchUrl } from './utils';

describe('parseProxyUrl', () => {
  it('未配置时返回 none', () => {
    expect(parseProxyUrl(undefined)).toEqual({ kind: 'none' });
    expect(parseProxyUrl('')).toEqual({ kind: 'none' });
    expect(parseProxyUrl('   ')).toEqual({ kind: 'none' });
  });

  it('解析 socks5（DNS 由代理端解析）', () => {
    const r = parseProxyUrl('socks5://127.0.0.1:9050');
    expect(r.kind).toBe('socks5');
    if (r.kind !== 'socks5') return;
    expect(r.host).toBe('127.0.0.1');
    expect(r.port).toBe(9050);
  });

  it('socks5h 与 socks5 行为一致（都由代理端解析域名）', () => {
    const a = parseProxyUrl('socks5://127.0.0.1:9050');
    const b = parseProxyUrl('socks5h://127.0.0.1:9050');
    expect(a).toEqual(b);
  });

  it('解析带凭据的 socks5', () => {
    const r = parseProxyUrl('socks5://user:pass@1.2.3.4:1080');
    expect(r.kind).toBe('socks5');
    if (r.kind !== 'socks5') return;
    expect(r.username).toBe('user');
    expect(r.password).toBe('pass');
  });

  it('socks5 默认端口 1080', () => {
    const r = parseProxyUrl('socks5://127.0.0.1');
    expect(r.kind).toBe('socks5');
    if (r.kind !== 'socks5') return;
    expect(r.port).toBe(1080);
  });

  it('解析 http 代理', () => {
    const r = parseProxyUrl('http://127.0.0.1:7890');
    expect(r.kind).toBe('http');
  });

  it('非法协议必须报错而不是静默直连', () => {
    // 关键：配错代理时若静默回退直连，等于隐私保护形同虚设
    expect(() => parseProxyUrl('ftp://127.0.0.1:21')).toThrow(/不支持/);
    expect(() => parseProxyUrl('not a url')).toThrow(/格式非法/);
  });

  it('缺少主机名时报错', () => {
    expect(() => parseProxyUrl('http://')).toThrow();
  });
});

describe('toSameOriginPlayback', () => {
  it('上游地址改写为同源代理', () => {
    const r = toSameOriginPlayback('https://cdn.example.com/2024/movie/1080.m3u8');
    expect(r.startsWith('/api/proxy?url=')).toBe(true);
    expect(decodeURIComponent(r.slice('/api/proxy?url='.length))).toBe(
      'https://cdn.example.com/2024/movie/1080.m3u8'
    );
  });

  it('已是代理地址的不二次包装', () => {
    const already = '/api/proxy?url=https%3A%2F%2Fx.test%2Fa.m3u8';
    expect(toSameOriginPlayback(already)).toBe(already);
    const live = '/api/live/stream?url=https%3A%2F%2Fx.test%2Fa.m3u8';
    expect(toSameOriginPlayback(live)).toBe(live);
  });

  it('非 http 协议保持原样', () => {
    expect(toSameOriginPlayback('data:video/mp4;base64,AAAA')).toBe('data:video/mp4;base64,AAAA');
    expect(toSameOriginPlayback('blob:http://localhost:8080/abc')).toBe('blob:http://localhost:8080/abc');
  });

  it('空值安全', () => {
    expect(toSameOriginPlayback('')).toBe('');
  });

  it('批量改写', () => {
    const r = toSameOriginEpisodes(['https://a.test/1.m3u8', 'https://b.test/2.m3u8']);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.startsWith('/api/proxy?url='))).toBe(true);
  });
});

describe('toUpstreamUrl', () => {
  it('代理地址还原为上游地址', () => {
    const upstream = 'https://cdn.example.com/a/b.m3u8';
    const proxied = toSameOriginPlayback(upstream);
    expect(toUpstreamUrl(proxied)).toBe(upstream);
  });

  it('非代理地址原样返回', () => {
    expect(toUpstreamUrl('https://x.test/a.m3u8')).toBe('https://x.test/a.m3u8');
  });

  it('往返一致', () => {
    const upstream = 'https://cdn.test/路径/中文.m3u8?a=1&b=2';
    expect(toUpstreamUrl(toSameOriginPlayback(upstream))).toBe(upstream);
  });
});

describe('buildWatchUrl 隐私设计', () => {
  it('片名与直链不进入查询串', () => {
    const url = buildWatchUrl({
      sourceKey: 'src1',
      vodId: '123',
      index: 2,
      title: '战狼',
      episodeUrl: 'https://cdn.test/wolf.m3u8',
    });
    // 查询串部分不含片名
    const query = url.split('#')[0];
    expect(query).not.toContain('战狼');
    expect(query).not.toContain('wolf');
    expect(query).toContain('source=src1');
    expect(query).toContain('id=123');
    expect(query).toContain('index=2');
  });

  it('敏感参数放在片段里', () => {
    const url = buildWatchUrl({
      sourceKey: 'src1',
      vodId: '123',
      title: '战狼',
      episodeUrl: 'https://cdn.test/wolf.m3u8',
    });
    expect(url).toContain('#');
    const frag = parseWatchFragment(url.split('#')[1]);
    expect(frag.title).toBe('战狼');
    expect(frag.episodeUrl).toBe('https://cdn.test/wolf.m3u8');
  });

  it('无敏感参数时不产生片段', () => {
    const url = buildWatchUrl({ sourceKey: 'src1', vodId: '9' });
    expect(url).not.toContain('#');
  });
});

describe('parseWatchFragment', () => {
  it('解析带 # 前缀的片段', () => {
    const r = parseWatchFragment('#title=战狼&url=https%3A%2F%2Fx.test%2Fa.m3u8');
    expect(r.title).toBe('战狼');
    expect(r.episodeUrl).toBe('https://x.test/a.m3u8');
  });

  it('解析不带 # 前缀的片段', () => {
    const r = parseWatchFragment('title=abc');
    expect(r.title).toBe('abc');
  });

  it('空片段返回空对象', () => {
    expect(parseWatchFragment('')).toEqual({});
    expect(parseWatchFragment('#')).toEqual({});
  });
});
