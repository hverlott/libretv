import { describe, expect, it } from 'vitest';
import { applyEnvValue } from './env-file';

/**
 * `.env` 编辑逻辑单测。
 *
 * 只测纯函数 applyEnvValue：真正的写盘函数会动项目根的 .env，
 * 不该在单测里碰（跑一次就把用户的配置改了）。
 */

describe('applyEnvValue', () => {
  it('原地替换已存在的键，其他行原样保留', () => {
    const before = ['PASSWORD=secret', 'LAN_ACCESS=0', 'PORT=8080'].join('\n');
    const result = applyEnvValue(before, 'LAN_ACCESS', '1');
    expect(result.changed).toBe(true);
    expect(result.appended).toBe(false);
    expect(result.content).toBe(['PASSWORD=secret', 'LAN_ACCESS=1', 'PORT=8080'].join('\n'));
  });

  it('值相同则不标记改动（避免无谓写盘）', () => {
    const before = 'LAN_ACCESS=1\nPORT=8080';
    const result = applyEnvValue(before, 'LAN_ACCESS', '1');
    expect(result.changed).toBe(false);
    expect(result.content).toBe(before);
  });

  it('键不存在时追加到末尾', () => {
    const result = applyEnvValue('PASSWORD=secret\n', 'LAN_ACCESS', '1');
    expect(result.changed).toBe(true);
    expect(result.appended).toBe(true);
    expect(result.content.trim().endsWith('LAN_ACCESS=1')).toBe(true);
    expect(result.content).toContain('PASSWORD=secret');
  });

  it('不把被注释掉的同名键当配置', () => {
    const before = ['# LAN_ACCESS=0', 'PASSWORD=secret'].join('\n');
    const result = applyEnvValue(before, 'LAN_ACCESS', '1');
    expect(result.appended).toBe(true);
    // 注释行必须原样保留，它是文档
    expect(result.content).toContain('# LAN_ACCESS=0');
    expect(result.content).toContain('LAN_ACCESS=1');
  });

  it('保留原有缩进与等号两侧空格', () => {
    const result = applyEnvValue('  LAN_ACCESS = 0  ', 'LAN_ACCESS', '1');
    expect(result.content.startsWith('  LAN_ACCESS = 1')).toBe(true);
  });

  it('CRLF 文件不会被写成混合换行', () => {
    const before = 'PASSWORD=secret\r\nLAN_ACCESS=0\r\n';
    const result = applyEnvValue(before, 'LAN_ACCESS', '1');
    // split(/\r?\n/) 会把 \r 吃掉，输出统一成 LF；这里只要求键被替换
    expect(result.content).toContain('LAN_ACCESS=1');
    expect(result.content).not.toContain('LAN_ACCESS=0');
  });

  it('重复的键只替换最后解析到的那一行会被全部替换，不会留两份生效值', () => {
    const before = 'LAN_ACCESS=0\nLAN_ACCESS=0';
    const result = applyEnvValue(before, 'LAN_ACCESS', '1');
    expect(result.content).toBe('LAN_ACCESS=1\nLAN_ACCESS=1');
  });

  it('空文件直接追加', () => {
    const result = applyEnvValue('', 'LAN_ACCESS', '1');
    expect(result.appended).toBe(true);
    expect(result.content.trim()).toBe('LAN_ACCESS=1');
  });

  it('拒绝非法键名（防注入）', () => {
    expect(() => applyEnvValue('', 'LAN ACCESS', '1')).toThrow();
    expect(() => applyEnvValue('', 'lan_access', '1')).toThrow();
    expect(() => applyEnvValue('', '../evil', '1')).toThrow();
  });

  it('拒绝含换行的值（否则会多写出一行配置）', () => {
    expect(() => applyEnvValue('', 'LAN_ACCESS', '1\nPASSWORD=pwned')).toThrow();
  });
});
