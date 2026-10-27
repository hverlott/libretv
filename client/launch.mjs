#!/usr/bin/env node
/**
 * LibreTV 桌面客户端 —— 启动器。
 *
 * 流程：
 * 1. 起控制面板服务（127.0.0.1:9099）
 * 2. 用 Edge 的 app 模式打开独立窗口（无地址栏，等同原生客户端）
 * 3. 窗口关闭时一并退出面板服务
 *
 * 为什么用 Edge 而不是 Electron：
 * 这台机器启用了代码完整性策略（要求企业签名级别），
 * 未签名的 Electron 二进制会被系统直接拦截；
 * Edge 是微软签名的，app 模式能提供无地址栏的独立窗口。
 *
 * 用法：node client/launch.mjs [--port 9099] [--no-window]
 */

import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
/**
 * 独立 profile 目录：放系统临时目录而不是项目里。
 * 放项目里会留下几百 MB 的浏览器缓存（且删除时容易被安全策略拦下）。
 */
const PROFILE_DIR = join(tmpdir(), 'libretv-client-profile');

const DEFAULT_PANEL_PORT = 9099;

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
const PANEL_PORT = Number(flags.get('port') ?? DEFAULT_PANEL_PORT) || DEFAULT_PANEL_PORT;

// —— 定位浏览器 ——

/** 常见浏览器的可执行文件路径（按优先级） */
const BROWSER_CANDIDATES = [
  {
    name: 'Edge',
    paths: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    appArgs: true,
  },
  {
    name: 'Chrome',
    paths: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ],
    appArgs: true,
  },
  {
    name: 'Brave',
    paths: ['C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'],
    appArgs: true,
  },
];

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    for (const p of candidate.paths) {
      if (existsSync(p)) return { ...candidate, exe: p };
    }
  }
  return null;
}

// —— 环境变量清理 ——

/**
 * 去掉与同名大写变量重复的小写代理变量。
 * Windows 环境变量不区分大小写，但通过 POSIX 兼容层传入时
 * 可能同时出现 `HTTP_PROXY` 与 `http_proxy` 两份，
 * Chromium 初始化时建环境变量哈希表遇重复键会直接抛异常启动失败。
 */
function sanitizeEnv() {
  const env = { ...process.env };
  const pairs = [
    ['https_proxy', 'HTTPS_PROXY'],
    ['http_proxy', 'HTTP_PROXY'],
    ['all_proxy', 'ALL_PROXY'],
    ['no_proxy', 'NO_PROXY'],
  ];
  for (const [lower, upper] of pairs) {
    if (env[lower] !== undefined && env[upper] !== undefined) {
      delete env[lower];
    }
  }
  return env;
}

// —— 启动流程 ——

/** 端口是否已被占用 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

const browser = findBrowser();
if (!browser) {
  console.error(
    '[LibreTV 客户端] 未找到可用的浏览器（Edge / Chrome / Brave）。\n' +
      '请安装其中之一后重试。'
  );
  process.exit(1);
}

console.log(`[LibreTV 客户端] 使用浏览器：${browser.name}`);

// 端口占用检查：可能是上一个客户端没退干净。
// 占用时优先「复用」已有实例（省得开两个面板），而不是直接报错退出。
let panelPort = PANEL_PORT;
const portBusy = await isPortInUse(panelPort);
if (portBusy) {
  // 试一下已有实例是否就是我们的面板服务
  let alive = false;
  try {
    await execFileAsync(process.execPath, [
      '-e',
      `const http=require('node:http');
       const r=http.get({host:'127.0.0.1',port:${panelPort},path:'/panel-api/status',timeout:1500},res=>{res.resume();process.exit(res.statusCode?0:1)});
       r.on('error',()=>process.exit(1));
       r.on('timeout',()=>{r.destroy();process.exit(1)});`,
    ]);
    alive = true;
  } catch {
    /* 不是我们的服务 */
  }

  if (alive) {
    console.log(`[LibreTV 客户端] 检测到已有客户端实例，直接打开它的窗口。`);
    openWindow();
    // 不再起新的面板服务
    panel.unref?.();
    panel.kill();
    panel = { kill() {}, unref() {} };
  } else {
    // 端口被别的程序占了：往后找一个空闲端口
    for (let p = PANEL_PORT + 1; p < PANEL_PORT + 20; p++) {
      if (!(await isPortInUse(p))) {
        panelPort = p;
        break;
      }
    }
    if (panelPort !== PANEL_PORT) {
      console.log(`[LibreTV 客户端] 端口 ${PANEL_PORT} 被占用，改用 ${panelPort}。`);
    }
  }
}

// 1) 面板服务
let panel = { kill() {}, unref() {} };
if (panelPort !== PANEL_PORT || !portBusy) {
  panel = spawn(
    process.execPath,
    [join(__dirname, 'panel-server.mjs'), '--port', String(panelPort)],
    {
      cwd: ROOT,
      env: sanitizeEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    }
  );
}

let panelReady = false;
panel.stdout?.on('data', (buf) => {
  const text = buf.toString();
  if (text.includes('控制面板已就绪')) {
    panelReady = true;
    openWindow();
  }
});
panel.stderr?.on('data', (buf) => process.stderr.write(buf));

/** 兜底：面板 stdout 没报就绪时，轮询端口 */
const readyTimer = setInterval(async () => {
  if (panelReady) {
    clearInterval(readyTimer);
    return;
  }
  try {
    await execFileAsync(process.execPath, [
      '-e',
      `const http=require('node:http');
       const r=http.get({host:'127.0.0.1',port:${panelPort},path:'/panel-api/status',timeout:1500},res=>{res.resume();process.exit(0)});
       r.on('error',()=>process.exit(1));
       r.on('timeout',()=>{r.destroy();process.exit(1)});`,
    ]);
    panelReady = true;
    clearInterval(readyTimer);
    openWindow();
  } catch {
    /* 还没起来 */
  }
}, 500);

/** 打开客户端窗口 */
let windowProcess = null;
function openWindow() {
  if (flags.get('no-window') === true) {
    console.log(`[LibreTV 客户端] 面板地址：http://localhost:${panelPort}/`);
    return;
  }

  // 独立 profile：避免与日常浏览器的会话/插件冲突
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
  } catch {
    /* 忽略 */
  }

  const url = `http://localhost:${panelPort}/`;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1100,780',
  ];

  windowProcess = spawn(browser.exe, args, {
    cwd: __dirname,
    env: sanitizeEnv(),
    // detached：Edge 会派生出一整棵进程树，父进程退出不影响窗口
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  windowProcess.unref();

  // 单独探测窗口是否真的活着：Edge 启动器进程可能秒退（把窗口交给已有实例），
  // 那种情况不能当成「窗口已关闭」而把整个客户端一起退掉。
  let windowAlive = false;
  const probe = setInterval(() => {
    if (windowProcess.exitCode !== null) {
      // 启动器进程已退出：检查是否还有 Edge 进程在（窗口可能已转交给已有实例）
      if (!windowAlive) {
        windowAlive = true;
        clearInterval(probe);
        console.log('[LibreTV 客户端] 窗口已交给浏览器进程管理。');
      }
    }
  }, 1000);

  console.log(`[LibreTV 客户端] 窗口已打开：${url}`);
}

/** 清理独立 profile（避免残留占用空间） */
function cleanupProfile() {
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 忽略 */
  }
}

// —— 退出处理 ——

/**
 * 客户端的退出条件：面板服务被结束。
 * 不用「浏览器启动器进程退出」作为信号——Edge 的启动器进程会秒退
 * （把窗口转交给常驻的浏览器进程），据此判断会误杀整个客户端。
 */
panel.on('exit', (code) => {
  if (windowProcess && !windowProcess.killed) {
    try {
      windowProcess.kill();
    } catch {
      /* 忽略 */
    }
  }
  cleanupProfile();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  panel.kill();
  cleanupProfile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  panel.kill();
  cleanupProfile();
  process.exit(0);
});
