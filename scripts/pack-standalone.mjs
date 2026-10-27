#!/usr/bin/env node
/**
 * 打包「可拷到别的设备直接跑」的产物。
 *
 * ## 为什么需要
 *
 * 在手机上直接 `npm install && next build` 大概率失败：Next 的 SWC 编译器
 * 是带平台后缀的原生二进制（@next/swc-linux-arm64-gnu 之类），而 Termux 用的是
 * Android bionic libc，装得上但加载不了。所以正确路径是**电脑上构建、设备上只跑**。
 *
 * 运行期只需要纯 JS（实测产物里除一个没用到的 sharp 平台包外没有任何 .node），
 * 所以把 standalone 组装好拷过去，`node server.js` 就能起。
 *
 * ## 为什么不能直接拷 .next/standalone
 *
 * 1. standalone 里**不带** `.next/static` 和 `public`——缺了页面没样式、图标全 404；
 * 2. 里面还夹带了构建机的 `@img/sharp-win32-x64`（19MB），拷到 ARM 上纯属死重量；
 * 3. 项目根的 `.runtime/` 会被 trace 进来，带着旧 PID、日志、漫画索引，
 *    拷到新设备上会被 ctl 误判「服务已在运行」。
 *
 * 用法：
 *   node scripts/pack-standalone.mjs                 # 产物到 .runtime/standalone-package
 *   node scripts/pack-standalone.mjs --out /tmp/pkg  # 指定输出目录
 *   node scripts/pack-standalone.mjs --zip           # 额外打一个 tar.gz 方便传输
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(process.argv[1], '..', '..');
const STANDALONE = join(ROOT, '.next', 'standalone');

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const OUT = resolve(typeof flags.get('out') === 'string' ? flags.get('out') : join(ROOT, '.runtime', 'standalone-package'));

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* 忽略 */
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// —— 1. 前置检查 ——
if (!existsSync(STANDALONE)) {
  console.error('[-] 找不到 .next/standalone。');
  console.error('    这是 Docker 构建模式的产物，请先执行：');
  console.error('      npm run build:standalone        （或 DOCKER_BUILD=1 npm run build）');
  process.exit(1);
}
if (!existsSync(join(STANDALONE, '.next'))) {
  console.error('[-] standalone 里缺 .next 目录，构建可能不完整，请重新构建。');
  process.exit(1);
}
for (const required of [join(ROOT, '.next', 'static'), join(ROOT, 'public')]) {
  if (!existsSync(required)) {
    console.error(`[-] 缺少 ${required}，请重新构建。`);
    process.exit(1);
  }
}

// —— 2. 组装 ——
console.log(`[*] 输出目录：${OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

cpSync(STANDALONE, OUT, { recursive: true });
// 静态资源与 public 不在 standalone 里，必须单独补（Dockerfile 也是这么做的）
cpSync(join(ROOT, '.next', 'static'), join(OUT, '.next', 'static'), { recursive: true });
cpSync(join(ROOT, 'public'), join(OUT, 'public'), { recursive: true });

// —— 3. 清理不该带走的东西 ——
const removed = [];

// 运行期不用 sharp（images.unoptimized + 全站没有 next/image），
// 构建机的平台包拷到别的架构上是纯死重量，还可能被误加载
const imgDir = join(OUT, 'node_modules', '@img');
if (existsSync(imgDir)) {
  for (const entry of readdirSync(imgDir)) {
    // wasm32 是跨平台兜底，留着不碍事；其余都是特定平台二进制
    if (entry.startsWith('sharp-') && !entry.startsWith('sharp-wasm32')) {
      rmSync(join(imgDir, entry), { recursive: true, force: true });
      removed.push(`node_modules/@img/${entry}`);
    }
  }
}

// 项目根的 .runtime 会被 trace 进来，带着旧 PID / 日志 / 索引
const runtimeDir = join(OUT, '.runtime');
if (existsSync(runtimeDir)) {
  rmSync(runtimeDir, { recursive: true, force: true });
  removed.push('.runtime/（旧 PID、日志、漫画索引）');
}

// —— 4. 报告 ——
if (removed.length) {
  console.log('[*] 已剔除：');
  for (const item of removed) console.log(`      - ${item}`);
}

const envFile = join(OUT, '.env');
if (existsSync(envFile)) {
  console.log('[*] 产物内含 .env（访问密码等配置会一起带过去，别把这个目录发给别人）');
} else {
  console.log('[!] 产物内没有 .env：目标设备上需要自己创建，至少要有一行 PASSWORD=...');
  writeFileSync(
    join(OUT, 'README-部署.txt'),
    [
      '目标设备上运行前，先在本目录创建 .env：',
      '',
      '  PASSWORD=你自己的口令',
      '  LAN_ACCESS=1',
      '',
      '然后：PORT=8080 HOSTNAME=0.0.0.0 node server.js',
      '',
      '注意：不要用 npm install / next build，运行期只需要 Node 22 + 本目录。',
    ].join('\n'),
    'utf8'
  );
}

// —— 4.5 Termux / Linux 启动脚本 ——
// 换行必须是 LF：Windows 上写 CRLF 拷到 Termux，
// 会报 `/bin/sh^M: bad interpreter`，而且肉眼完全看不出问题
const startScript = [
  '#!/bin/sh',
  '# LibreTV 启动脚本（Termux / 任意 Linux）',
  '# 用法：sh start.sh          不想每次输密码的话，先 chmod +x start.sh 再 ./start.sh',
  'cd "$(dirname "$0")" || exit 1',
  '',
  'PORT="${PORT:-8080}"',
  'HOSTNAME="${HOSTNAME:-0.0.0.0}"',
  'export PORT HOSTNAME',
  '',
  '# Termux：拿唤醒锁，否则系统会把进程冻住（Android 的后台管控）',
  'if command -v termux-wake-lock >/dev/null 2>&1; then',
  '  termux-wake-lock 2>/dev/null && echo "[*] 已获取 Termux 唤醒锁"',
  'fi',
  '',
  'echo "[*] 启动 LibreTV：http://0.0.0.0:${PORT}"',
  '',
  '# 崩溃自动重启；Ctrl+C（130）与正常退出（0）不重启',
  'while true; do',
  '  node server.js',
  '  code=$?',
  '  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then',
  '    echo "[*] 已退出（$code）"',
  '    break',
  '  fi',
  '  echo "[!] 服务异常退出（$code），3 秒后重启…"',
  '  sleep 3',
  'done',
  '',
].join('\n');
writeFileSync(join(OUT, 'start.sh'), startScript, 'utf8');
console.log('[*] 已生成 start.sh（LF 换行，Termux 里用 sh start.sh 运行）');

// —— 5. 可选打包 ——
const total = dirSize(OUT);
console.log(`[+] 完成，共 ${mb(total)}`);

if (flags.get('zip') === true) {
  const archive = `${OUT}.tar.gz`;
  try {
    execFileSync('tar', ['-czf', archive, '-C', OUT, '.'], { stdio: 'inherit' });
    console.log(`[+] 已打包：${archive}（${mb(dirSize(archive))}）`);
  } catch (err) {
    console.error(`[-] 打 tar.gz 失败（可选步骤）：${err instanceof Error ? err.message : err}`);
    console.error('    Windows 自带的 tar 应该可用；也可以直接用 U 盘 / 局域网共享拷目录。');
  }
}

console.log('');
console.log('下一步：把整个目录拷到目标设备，然后在该目录内执行');
console.log('  PORT=8080 HOSTNAME=0.0.0.0 node server.js');
console.log('（Termux 里同样适用，不需要 npm install，也不需要 next build）');
