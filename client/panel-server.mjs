#!/usr/bin/env node
/**
 * LibreTV 桌面客户端 —— 控制面板服务。
 *
 * 为什么是「本地 HTTP 服务 + Edge app 窗口」而不是 Electron：
 * 这台机器启用了代码完整性策略（要求企业签名级别），
 * 未签名的 Electron 二进制会被系统直接拦截跑不起来。
 * Edge 是微软签名的，用它的 app 模式（无地址栏的独立窗口）承载界面，
 * 零额外二进制、零签名问题，体验上与原生客户端一致。
 *
 * 职责：
 * - 托管控制面板页面（状态 / 启停 / 进入系统）
 * - 提供启停 API，内部调用 scripts/ctl.mjs（与双击 .bat 同一套逻辑）
 * - 代理 LibreTV 页面：/app/* → http://localhost:8080/*
 *   这样「进入系统」是同源导航，播放器全屏、Cookie、跨域都正常
 *
 * 用法：node client/panel-server.mjs [--port 9099]
 */

import { createServer, request as httpRequestRaw } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CTL_SCRIPT = join(ROOT, 'scripts', 'ctl.mjs');
const RUNTIME_DIR = join(ROOT, '.runtime');
const PID_FILE = join(RUNTIME_DIR, 'libretv.pid');
const PORT_FILE = join(RUNTIME_DIR, 'libretv.port');
const STARTED_FILE = join(RUNTIME_DIR, 'libretv.started');
const PANEL_DIR = join(__dirname, 'panel');

const DEFAULT_PANEL_PORT = 9099;
const DEFAULT_SERVICE_PORT = 8080;

// —— 参数 ——

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

// —— 状态 ——

function readTextFile(file) {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf-8').trim();
  } catch {
    return null;
  }
}

function servicePort() {
  const p = Number(readTextFile(PORT_FILE));
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_SERVICE_PORT;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** 读取服务状态：先用 PID 文件，再退到端口探测（与 ctl.mjs 同源） */
async function getServiceStatus() {
  const port = servicePort();
  const pidText = readTextFile(PID_FILE);
  const pid = pidText ? Number(pidText) : null;

  if (pid && isProcessAlive(pid)) {
    const startedAt = Number(readTextFile(STARTED_FILE));
    const valid = Number.isFinite(startedAt) && startedAt > 0;
    return {
      running: true,
      pid,
      port,
      uptimeMs: valid ? Date.now() - startedAt : null,
      startedAt: valid ? startedAt : null,
      detectedBy: 'pid-file',
      root: ROOT,
    };
  }

  if (await probeService(port)) {
    return {
      running: true,
      pid: null,
      port,
      uptimeMs: null,
      startedAt: null,
      detectedBy: 'port',
      root: ROOT,
    };
  }

  return {
    running: false,
    pid: null,
    port,
    uptimeMs: null,
    startedAt: null,
    detectedBy: 'none',
    root: ROOT,
  };
}

/** 探测服务是否在响应 */
function probeService(port) {
  return new Promise((resolvePromise) => {
    const req = execFileAsync(process.execPath, ['-e', `
const http = require('node:http');
const req = http.get({ host: '127.0.0.1', port: ${port}, path: '/api/status', timeout: 2500 }, (res) => {
  res.resume();
  process.exit(res.statusCode ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
`], { timeout: 6000, windowsHide: true })
      .then(() => resolvePromise(true))
      .catch(() => resolvePromise(false));
  });
}

// —— 启停（复用 ctl.mjs） ——

function runCtl(args, timeout = 180000) {
  return new Promise((resolvePromise) => {
    execFileAsync(process.execPath, [CTL_SCRIPT, ...args], {
      cwd: ROOT,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
      .then(({ stdout, stderr }) =>
        resolvePromise({ ok: true, out: (stdout || '').trim(), err: (stderr || '').trim() })
      )
      .catch((err) =>
        resolvePromise({
          ok: false,
          out: (err.stdout || '').trim(),
          err: (err.stderr || '').trim(),
          message: err.message,
        })
      );
  });
}

async function startService() {
  const before = await getServiceStatus();
  if (before.running) {
    return { ok: true, message: `服务已在运行（端口 ${before.port}）` };
  }
  const result = await runCtl(['start', '--no-open', '--no-build']);
  if (!result.ok) {
    return { ok: false, message: result.out || result.err || '启动失败' };
  }
  const port = servicePort();
  for (let i = 0; i < 40; i++) {
    if (await probeService(port)) {
      return { ok: true, message: result.out || '服务已启动' };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, message: '服务启动超时，请查看 .runtime/libretv.log' };
}

async function stopService() {
  const before = await getServiceStatus();
  if (!before.running) {
    return { ok: true, message: '服务当前未在运行' };
  }
  const result = await runCtl(['stop']);
  const port = before.port;
  for (let i = 0; i < 30; i++) {
    if (!(await probeService(port))) {
      return { ok: true, message: result.out || '服务已停止' };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: true, message: result.out || '已发出停止指令' };
}

async function restartService() {
  await stopService();
  return startService();
}

// —— HTTP 处理 ——

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Host 头必须是本机面板地址。
 *
 * 阻断 DNS rebinding：攻击者把某个域名解析到 127.0.0.1，
 * 浏览器访问该域名时 Host 头就是那个域名 —— 校验不通过即被拒。
 */
function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return false;
  // 允许 127.0.0.1 / localhost / [::1]，端口需与面板一致
  const allowed = new Set([`127.0.0.1:${PANEL_PORT}`, `localhost:${PANEL_PORT}`, `[::1]:${PANEL_PORT}`]);
  if (allowed.has(hostHeader.toLowerCase())) return true;
  // 不带端口的裸主机名（HTTP/1.0 客户端）
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader.toLowerCase());
}

/** Origin 必须是本机面板来源 */
function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 面板自身的安全响应头。
 *
 * 与主站保持一致的隐私基线：禁止被索引、禁止被嵌入、禁止嗅探 MIME、
 * 不外发 Referer（面板页面里的路径不含片名，但保持一致的策略更省心）。
 */
const PANEL_SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    ...PANEL_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file) {
  if (!existsSync(file)) {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  const body = readFileSync(file);
  res.writeHead(200, {
    ...PANEL_SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/** 反向代理：把请求转发到 LibreTV 服务 */
function proxyToService(req, res, pathname, search) {
  const port = servicePort();
  const target = `http://127.0.0.1:${port}${pathname}${search ?? ''}`;

  // 补 Referer：豆瓣等图床有防盗链，缺 Referer 会返回 418，
  // 表现为封面图全裂。
  // 请求头处理：
  // - Referer 补上：豆瓣等图床有防盗链，缺 Referer 返回 418（封面图全裂）
  // - **Origin / Referer 原样转发**：会话 Cookie 是 SameSite=lax，
  //   浏览器会拿 Origin 头与页面 origin 比对来判定是否跨站。
  //   若把 Origin 改写成上游的 http://localhost:8080，就与页面 origin
  //   (http://localhost:9099) 不一致 → 判定跨站 → fetch 不带 Cookie → 全站 401。
  const headers = { ...req.headers };
  if (!headers.referer) {
    headers.referer = `http://localhost:${port}/`;
  }
  delete headers.host;
  // 强制上游不压缩：代理层不改写响应体，压缩转发需要额外的解压/重压，
  // 而这些响应都很小，交给上游按明文返回更简单可靠。
  headers['accept-encoding'] = 'identity';

  const proxyReq = httpRequest(target, req.method, headers, (proxyRes) => {
    const outHeaders = { ...proxyRes.headers };
    // content-encoding / content-length 必须原样透传：
    // 去掉 content-encoding 会让浏览器把 gzip 字节当 UTF-8 文本解码（乱码）；
    // 去掉 content-length 则会导致响应体长度与声明不符（截断）。
    // 只去掉 CSP——它会限制被代理页面加载自己的资源。
    delete outHeaders['content-security-policy'];
    res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px;text-align:center">' +
        '<h2>服务未运行</h2><p>请回到控制面板点击「开启服务」。</p>' +
        '<script>setTimeout(()=>location.href="/",1500)</script>'
    );
  });
  req.pipe(proxyReq);
}

/** 发起对本地服务的 HTTP 请求 */
function httpRequest(url, method, headers, onResponse) {
  const u = new URL(url);
  return httpRequestRaw(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, host: `127.0.0.1:${u.port}` },
    },
    onResponse
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PANEL_PORT}`);
  const pathname = url.pathname;

  try {
    // —— 跨站请求防护 ——
    // 面板虽只监听 127.0.0.1，但任意网页都能向本机端口发请求
    // （DNS rebinding / 直接 fetch 127.0.0.1），从而让第三方：
    //   - 停掉你的服务（DoS）；
    //   - 读取服务日志（可能含上游请求信息）；
    //   - 借助 /app/* 反向代理以你的身份访问 LibreTV 接口。
    // 这里做两层校验：Host 必须是本机面板地址（阻断 rebinding），
    // 且带 Origin 时必须同源（阻断普通跨站 fetch）。
    if (!isLocalHostHeader(req.headers.host)) {
      sendJson(res, 403, { error: '仅允许本机访问' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) {
      sendJson(res, 403, { error: '拒绝跨站请求' });
      return;
    }

    // —— API ——
    if (pathname === '/panel-api/status' && req.method === 'GET') {
      sendJson(res, 200, await getServiceStatus());
      return;
    }
    if (pathname === '/panel-api/start' && req.method === 'POST') {
      const result = await startService();
      sendJson(res, result.ok ? 200 : 500, { ...result, status: await getServiceStatus() });
      return;
    }
    if (pathname === '/panel-api/stop' && req.method === 'POST') {
      const result = await stopService();
      sendJson(res, result.ok ? 200 : 500, { ...result, status: await getServiceStatus() });
      return;
    }
    if (pathname === '/panel-api/restart' && req.method === 'POST') {
      const result = await restartService();
      sendJson(res, result.ok ? 200 : 500, { ...result, status: await getServiceStatus() });
      return;
    }
    if (pathname === '/panel-api/logs' && req.method === 'GET') {
      const logFile = join(RUNTIME_DIR, 'libretv.log');
      const content = readTextFile(logFile);
      const lines = Number(url.searchParams.get('lines') ?? 120);
      sendJson(res, 200, {
        ok: Boolean(content),
        text: content
          ? content.split(/\r?\n/).slice(-Math.max(1, Math.min(lines, 2000))).join('\n')
          : '暂无日志',
      });
      return;
    }

    // —— 静态面板 ——
    if (pathname === '/' || pathname === '/index.html') {
      sendFile(res, join(PANEL_DIR, 'index.html'));
      return;
    }
    if (pathname === '/panel.js' || pathname === '/panel.css') {
      sendFile(res, join(PANEL_DIR, pathname.slice(1)));
      return;
    }

    // —— 代理 LibreTV ——
    // 需要转发两类路径：
    // 1) /app/* —— 页面入口（客户端从这里进入系统）
    // 2) 根路径资源 —— Next.js 生成的 HTML 用**绝对根路径**引用
    //    （/_next/...、/icons/...、/favicon.ico），以及站内页面路由
    //    （/live、/system、/about 等）——这些都是客户端内的导航目标，
    //    不转发就会 404。
    if (
      pathname === '/app' ||
      pathname.startsWith('/app/') ||
      pathname.startsWith('/_next/') ||
      pathname.startsWith('/icons/') ||
      pathname.startsWith('/api/') ||
      pathname === '/live' ||
      pathname === '/manga' ||
      pathname.startsWith('/manga/') ||
      pathname === '/system' ||
      pathname === '/privacy' ||
      pathname === '/about' ||
      pathname === '/watch' ||
      pathname === '/favicon.ico' ||
      pathname === '/manifest.webmanifest'
    ) {
      const sub = pathname.startsWith('/app') ? pathname.slice('/app'.length) || '/' : pathname;
      proxyToService(req, res, sub, url.search);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PANEL_PORT, '127.0.0.1', () => {
  console.log(`[LibreTV 客户端] 控制面板已就绪：http://localhost:${PANEL_PORT}/`);
  console.log(`[LibreTV 客户端] 项目目录：${ROOT}`);
});

// 客户端窗口关闭后，面板服务也应退出（由 launch.mjs 负责管理生命周期）
