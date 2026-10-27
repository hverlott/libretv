import { describe, expect, it } from 'vitest';
import { CLIENT_BASE, detectBasePath, siteHref, withBasePath } from './base-path';

describe('客户端基路径', () => {
  describe('detectBasePath', () => {
    it('直连部署（无 /app 前缀）返回空', () => {
      expect(detectBasePath('/')).toBe('');
      expect(detectBasePath('/watch')).toBe('');
      expect(detectBasePath('/live')).toBe('');
      expect(detectBasePath('/system')).toBe('');
    });

    it('客户端（/app 前缀）返回 /app', () => {
      expect(detectBasePath('/app')).toBe(CLIENT_BASE);
      expect(detectBasePath('/app/')).toBe(CLIENT_BASE);
      expect(detectBasePath('/app/watch')).toBe(CLIENT_BASE);
      expect(detectBasePath('/app/live')).toBe(CLIENT_BASE);
    });

    it('空 pathname 返回空（SSR 阶段无前缀信息）', () => {
      expect(detectBasePath(null)).toBe('');
      expect(detectBasePath('')).toBe('');
    });

    it('不以 /app 开头的相似路径不算客户端', () => {
      // /application 不能被误判成 /app
      expect(detectBasePath('/application')).toBe('');
      expect(detectBasePath('/appx')).toBe('');
    });
  });

  describe('withBasePath', () => {
    it('无基路径时原样返回', () => {
      expect(withBasePath('/', '')).toBe('/');
      expect(withBasePath('/watch', '')).toBe('/watch');
    });

    it('有基路径时补上前缀', () => {
      expect(withBasePath('/', '/app')).toBe('/app');
      expect(withBasePath('/watch', '/app')).toBe('/app/watch');
      expect(withBasePath('/live', '/app')).toBe('/app/live');
    });

    it('已带前缀的不重复添加', () => {
      expect(withBasePath('/app', '/app')).toBe('/app');
      expect(withBasePath('/app/watch', '/app')).toBe('/app/watch');
    });

    it('相对路径不动', () => {
      expect(withBasePath('watch', '/app')).toBe('watch');
      expect(withBasePath('./x', '/app')).toBe('./x');
    });

    it('协议相对地址不动', () => {
      expect(withBasePath('//cdn.example.com/a', '/app')).toBe('//cdn.example.com/a');
    });
  });

  describe('siteHref', () => {
    it('直连时与原行为一致', () => {
      expect(siteHref('/', '/')).toBe('/');
      expect(siteHref('/watch', '/watch')).toBe('/watch');
    });

    it('客户端时补上 /app 前缀', () => {
      expect(siteHref('/', '/app/watch')).toBe('/app');
      expect(siteHref('/about', '/app/privacy')).toBe('/app/about');
    });
  });

  it('关键回归：客户端点主页按钮必须指向 /app 而非 /', () => {
    // 写死 href="/" 会跳到控制面板首页（页面看似没反应）——这正是要修的 bug
    expect(siteHref('/', '/app/watch')).not.toBe('/');
    expect(siteHref('/', '/app/watch')).toBe('/app');
  });
});
