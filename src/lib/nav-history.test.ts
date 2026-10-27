import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNavHistory,
  markRecordReplace,
  previousPath,
  recordVisit,
  truncateTo,
} from './nav-history';

/**
 * 导航记录单测。
 *
 * 运行环境是 node（没有 window），所以这里塞一个内存版 sessionStorage，
 * 模拟「桌面客户端里没有浏览器后退键、一切靠站内记录」的场景。
 */

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { sessionStorage: fakeStorage() });
  clearNavHistory();
});

describe('recordVisit / previousPath', () => {
  it('相邻重复不重复入栈', () => {
    recordVisit('/');
    recordVisit('/');
    expect(previousPath('/')).toBeUndefined();
  });

  it('能取到真正的上一级', () => {
    recordVisit('/');
    recordVisit('/?s=肖申克的救赎');
    recordVisit('/watch?source=env_0&id=1&index=0');

    expect(previousPath('/watch?source=env_0&id=1&index=0')).toBe('/?s=肖申克的救赎');
  });

  it('没有记录（首次直接打开）返回 undefined', () => {
    expect(previousPath('/watch?source=env_0&id=1')).toBeUndefined();
  });

  it('当前页重复出现在栈顶时跳过它', () => {
    recordVisit('/');
    recordVisit('/manga');
    recordVisit('/manga');
    expect(previousPath('/manga')).toBe('/');
  });

  it('只保留最近若干条，不会无限增长', () => {
    for (let i = 0; i < 30; i++) recordVisit(`/?s=${i}`);
    recordVisit('/watch?source=a&id=1');
    // 最老的几条已被丢弃，但上一级仍在
    expect(previousPath('/watch?source=a&id=1')).toBe('/?s=29');
  });
});

describe('truncateTo', () => {
  it('返回后目标页成为栈顶，再点返回不会横跳回原页', () => {
    recordVisit('/');
    recordVisit('/?s=x');
    recordVisit('/watch?source=a&id=1');

    const previous = previousPath('/watch?source=a&id=1');
    expect(previous).toBe('/?s=x');
    truncateTo('/?s=x');
    // 返回动作触发的记录，因为与栈顶相同而跳过
    recordVisit('/?s=x');

    // 现在在搜索页，上一级应该是首页，而不是刚才那个播放页
    expect(previousPath('/?s=x')).toBe('/');
  });

  it('目标不在栈里时补进去', () => {
    recordVisit('/watch?source=a&id=1');
    truncateTo('/manga');
    expect(previousPath('/manga')).toBe('/watch?source=a&id=1');
  });
});

describe('markRecordReplace', () => {
  it('切集只替换栈顶，不会把每一集都记成一页', () => {
    recordVisit('/');
    recordVisit('/?s=x');
    recordVisit('/watch?source=a&id=1&index=0');

    markRecordReplace();
    recordVisit('/watch?source=a&id=1&index=1');
    markRecordReplace();
    recordVisit('/watch?source=a&id=1&index=2');

    // 连换两集，上一级依然是搜索页
    expect(previousPath('/watch?source=a&id=1&index=2')).toBe('/?s=x');
  });

  it('只对紧接着的下一次记录生效', () => {
    recordVisit('/');
    recordVisit('/?s=x');
    markRecordReplace();
    recordVisit('/watch?source=a&id=1&index=1');
    recordVisit('/manga');

    expect(previousPath('/manga')).toBe('/watch?source=a&id=1&index=1');
  });
});

describe('无 window 环境', () => {
  it('SSR 阶段不抛错', () => {
    vi.stubGlobal('window', undefined);
    expect(() => recordVisit('/')).not.toThrow();
    expect(previousPath('/')).toBeUndefined();
    expect(() => truncateTo('/x')).not.toThrow();
    expect(() => clearNavHistory()).not.toThrow();
  });
});
