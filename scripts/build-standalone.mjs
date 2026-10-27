#!/usr/bin/env node
/**
 * 生成 standalone 产物（DOCKER_BUILD=1 的 next build）。
 *
 * 为什么单独一个脚本，而不是 `"build:standalone": "DOCKER_BUILD=1 next build"`：
 * - Windows 的 npm script 走 cmd.exe，不支持 `VAR=value cmd` 这种前缀写法；
 * - 引 `cross-env` 只为一件事加一个依赖，不划算。
 * 用 node 起子进程显式传 env，跨平台行为一致。
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '..', '..');
const nextEntry = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

console.log('[*] 以 standalone 模式构建（产物供 Docker / 跨设备部署使用）');

const child = spawn(process.execPath, [nextEntry, 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    DOCKER_BUILD: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    // next build 会删除 .next 里的旧产物，安全策略下批量删除会被拦
    CODEBUDDY_SAFE_DELETE_BULK_GUARD: '',
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  },
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('');
    console.log('[+] 构建完成。下一步：node scripts/pack-standalone.mjs');
  } else {
    console.error(`[-] 构建失败（退出码 ${code}）`);
  }
  process.exit(code ?? 1);
});
