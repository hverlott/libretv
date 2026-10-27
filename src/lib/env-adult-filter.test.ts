import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnvAdultFilter } from './env-adult-filter';

const KEY = 'DEFAULT_ADULT_FILTER';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  vi.restoreAllMocks();
});

describe('getEnvAdultFilter', () => {
  it('未配置时返回 undefined', () => {
    delete process.env[KEY];
    expect(getEnvAdultFilter()).toBeUndefined();
  });

  it('空值与纯空白视为未配置', () => {
    for (const v of ['', '   ']) {
      process.env[KEY] = v;
      expect(getEnvAdultFilter()).toBeUndefined();
    }
  });

  it('关闭过滤的各种写法都返回 false', () => {
    for (const v of ['false', 'FALSE', '0', 'off', 'no', ' false ']) {
      process.env[KEY] = v;
      expect(getEnvAdultFilter()).toBe(false);
    }
  });

  it('开启过滤的各种写法都返回 true', () => {
    for (const v of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) {
      process.env[KEY] = v;
      expect(getEnvAdultFilter()).toBe(true);
    }
  });

  it('非法取值返回 undefined 而非抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[KEY] = 'maybe';
    expect(getEnvAdultFilter()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
