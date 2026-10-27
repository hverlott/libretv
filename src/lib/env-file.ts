import fs from 'node:fs';
import path from 'node:path';

/**
 * `.env` 读写（仅供服务端，改完必须重启才生效——Next 在启动时读一次）。
 *
 * 只做「设置某个键」这一件事，不做通用配置编辑：
 * - 已存在生效行 → 原地替换，保留其他内容与顺序；
 * - 不存在 → 追加到文件末尾。
 *
 * 路径写死为项目根的 `.env`，不接受任何外部输入，避免变成任意文件写入。
 */

export const ENV_PATH = path.join(process.cwd(), '.env');

/** 键名白名单式校验：只允许 A-Z0-9_，杜绝注入换行等花招 */
function assertKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`非法配置键：${key}`);
  }
}

/** 值里不允许换行：否则写进 .env 会变成多行，污染后面的配置 */
function assertValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error('配置值不能包含换行');
}

export function readEnvFile(): string {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return '';
  }
}

/** 读某个键的生效值（跳过被注释掉的行） */
export function getEnvFileValue(key: string): string | undefined {
  assertKey(key);
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (const line of readEnvFile().split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(re);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

export interface EnvEditResult {
  content: string;
  changed: boolean;
  /** 是新增到文件末尾（而不是原地替换） */
  appended: boolean;
}

/**
 * 纯函数版的「设置某个键」：不碰磁盘，方便单测。
 */
export function applyEnvValue(content: string, key: string, value: string): EnvEditResult {
  assertKey(key);
  assertValue(value);

  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)(.*)$`);

  let changed = false;
  let found = false;
  const next = lines.map((line) => {
    // 注释行不动：`# KEY=old` 是文档，不是配置
    if (/^\s*#/.test(line)) return line;
    const m = line.match(re);
    if (!m) return line;
    found = true;
    if (m[2] === value) return line;
    changed = true;
    return `${m[1]}${value}`;
  });

  if (!found) {
    // 丢掉尾部空行再追加，避免每改一次就多一个空行
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
    next.push(`${key}=${value}`, '');
    changed = true;
  }

  return { content: next.join('\n'), changed, appended: !found };
}

/**
 * 写入某个键。返回是否真的改动了文件（值没变就不写，避免无谓的 mtime 变化）。
 */
export function setEnvFileValue(key: string, value: string): boolean {
  const { content, changed } = applyEnvValue(readEnvFile(), key, value);
  if (!changed) return false;

  // 落盘：先写临时文件再 rename，避免写到一半进程被杀留下半截 .env
  const tmp = `${ENV_PATH}.tmp`;
  fs.writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  fs.renameSync(tmp, ENV_PATH);
  return true;
}
