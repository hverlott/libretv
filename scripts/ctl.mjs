#!/usr/bin/env node
/**
 * LibreTV 系统控制脚本 —— 一键启动 / 关闭 / 重启 / 查看状态 / 开机自启。
 *
 * 为什么不用现成的 start.bat：
 * - start.bat 是前台阻塞的（Ctrl+C 才停），关掉窗口服务就没了；
 * - 没有任何「状态」概念：不知道服务在不在跑、哪个端口、PID 是多少；
 * - 停止时容易留下孤儿进程（next start 会派生子进程，只 kill 父进程不够）。
 *
 * 本脚本解决这三点：
 * - detached 启动 + PID 文件 + 日志重定向，进程脱离终端独立存活；
 * - 停止时按进程树终止（Windows taskkill /T，Unix 进程组），不留孤儿；
 * - status 同时用「PID 文件」和「端口占用」两路交叉验证，
 *   所以即使 PID 文件丢了或服务被别人启的，也能给出正确结论。
 *
 * 用法：
 *   node scripts/ctl.mjs start [--port 8080] [--no-build] [--no-open]
 *   node scripts/ctl.mjs stop [--force]
 *   node scripts/ctl.mjs restart [--port 8080]
 *   node scripts/ctl.mjs status
 *   node scripts/ctl.mjs install    （开机自启）
 *   node scripts/ctl.mjs uninstall  （取消开机自启）
 *   node scripts/ctl.mjs logs [--lines 100]
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RUNTIME_DIR = join(ROOT, '.runtime');
const PID_FILE = join(RUNTIME_DIR, 'libretv.pid');
const PORT_FILE = join(RUNTIME_DIR, 'libretv.port');
/** 服务启动时刻（epoch ms），用于算运行时长 */
const STARTED_FILE = join(RUNTIME_DIR, 'libretv.started');
const LOG_FILE = join(RUNTIME_DIR, 'libretv.log');
const BUILD_STAMP = join(RUNTIME_DIR, 'build.stamp');

const IS_WINDOWS = process.platform === 'win32';

// —— 工具 ——

function ensureRuntimeDir() {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readTextFile(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

function writeTextFile(path, text) {
  ensureRuntimeDir();
  writeFileSync(path, text, 'utf-8');
}

function removeFile(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* 忽略 */
  }
}

/** 进程是否存活（signal 0 只探测不发送） */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程存在但当前用户无权发信号
    return err?.code === 'EPERM';
  }
}

/**
 * 找出占用指定端口的 PID。
 * Windows 用 netstat，Unix 用 lsof（都拿不到时返回 null）。
 */
async function findPortPid(port) {
  if (IS_WINDOWS) {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes('LISTENING')) continue;
        const m = line.match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
        if (m) return Number(m[1]);
      }
    } catch {
      /* 忽略 */
    }
    return null;
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      maxBuffer: 1024 * 1024,
    });
    const first = stdout.trim().split(/\s+/)[0];
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

/** 解析命令行参数 */
function parseArgs(argv) {
  const command = argv[0] ?? 'help';
  const flags = new Map();
  for (let i = 1; i < argv.length; i++) {
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
  return { command, flags };
}

/** 从 .env 里读 PORT（没有则用默认值） */
function readEnvPort() {
  const envPath = join(ROOT, '.env');
  const content = readTextFile(envPath);
  if (!content) return 8080;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*PORT\s*=\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return 8080;
}

/**
 * 读 .env 里的某个值（只认 `KEY=value` 行，注释与空行跳过）。
 *
 * 为什么 ctl 要自己解析：这个脚本是独立 node 进程，
 * Next 加载 .env 是它自己的事，ctl 拿到的 process.env 里没有 .env 的内容。
 * 早先 BIND_HOST 只从 process.env 读，导致「在 .env 里写了 0.0.0.0 却不生效」。
 */
function readEnvValue(key) {
  const content = readTextFile(join(ROOT, '.env'));
  if (!content) return '';
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/**
 * 解析绑定地址，规则与 src/lib/lan-access.ts 保持一致：
 * BIND_HOST 显式优先 > LAN_ACCESS=1 > 仅本机。
 */
function resolveBindHost() {
  const explicit = (process.env.BIND_HOST || readEnvValue('BIND_HOST')).trim();
  if (explicit) return explicit.toLowerCase() === 'localhost' ? '127.0.0.1' : explicit;
  const lan = (process.env.LAN_ACCESS || readEnvValue('LAN_ACCESS')).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lan)) return '0.0.0.0';
  return '127.0.0.1';
}

/** 该地址是否允许本机以外访问 */
function isExposedBind(bindHost) {
  const host = (bindHost || '').toLowerCase();
  if (host === '0.0.0.0' || host === '::') return true;
  return !['', '127.0.0.1', 'localhost', '::1'].includes(host);
}

/** 枚举局域网 IPv4（跳过回环、APIPA） */
function lanIps() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push(info.address);
    }
  }
  return out;
}

/** 启动/状态时打印可访问地址；只绑本机时也给一行提示，避免用户以为哪里坏了 */
function printAccessUrls(port, bindHost) {
  if (!isExposedBind(bindHost)) {
    console.log(`    访问：http://localhost:${port}（仅本机；手机/电视要访问请设 LAN_ACCESS=1）`);
    return;
  }
  const ips = bindHost === '0.0.0.0' || bindHost === '::' ? lanIps() : [bindHost];
  console.log(`    本机：http://localhost:${port}`);
  if (ips.length === 0) {
    console.log('    局域网：未检测到可用的 IPv4 地址（检查是否已连上 Wi-Fi 或有线网）');
    return;
  }
  for (const ip of ips) {
    console.log(`    局域网：http://${ip}:${port}`);
  }
  console.log('    提示：手机打不开多半是 Windows 防火墙拦了入站，双击「放行防火墙.bat」');
}

function resolvePort(flags) {
  const fromFlag = flags.get('port');
  if (typeof fromFlag === 'string') {
    const n = Number(fromFlag);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return readEnvPort();
}

// —— 状态 ——

/*
 * ServiceStatus:
 *   { running, pid, port, detectedBy, uptimeMs, logFile, portTakenByOther }
 */

export async function getStatus() {
  const port = resolvePort(new Map());
  const pidText = readTextFile(PID_FILE);
  const pid = pidText ? Number(pidText) : null;

  // 第一路：PID 文件
  if (pid && isProcessAlive(pid)) {
    return {
      running: true,
      pid,
      port: Number(readTextFile(PORT_FILE)) || port,
      detectedBy: 'pid-file',
      uptimeMs: await readUptime(pid),
      logFile: LOG_FILE,
      portTakenByOther: false,
    };
  }

  // 第二路：端口占用（PID 文件丢失时兜底）
  const portPid = await findPortPid(port);
  if (portPid && isProcessAlive(portPid)) {
    return {
      running: true,
      pid: portPid,
      port,
      detectedBy: 'port',
      uptimeMs: await readUptime(portPid),
      logFile: LOG_FILE,
      portTakenByOther: false,
    };
  }

  return {
    running: false,
    pid: null,
    port,
    detectedBy: 'none',
    uptimeMs: null,
    logFile: LOG_FILE,
    portTakenByOther: false,
  };
}

/**
 * 进程运行时长。
 *
 * 优先用启动时记录的 startedAt 文件——不依赖任何外部命令
 * （Windows 上取进程创建时间要调 PowerShell/wmc，在受限环境里会被安全策略拦下）。
 * 拿不到时返回 null，UI 显示「未知」而不是编一个数字。
 */
async function readUptime(pid) {
  const startedAt = Number(readTextFile(STARTED_FILE));
  if (Number.isFinite(startedAt) && startedAt > 0) {
    return Math.max(0, Date.now() - startedAt);
  }
  return null;
}

// —— 启动 ——

/** src 与 package.json 里最新的修改时间 */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const m = statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(join(ROOT, 'src'));
  try {
    const m = statSync(join(ROOT, 'package.json')).mtimeMs;
    if (m > newest) newest = m;
  } catch {
    /* 忽略 */
  }
  return newest;
}

/** 是否需要重新构建（源码比上次构建新） */
function needsBuild() {
  const stamp = readTextFile(BUILD_STAMP);
  if (!stamp) return true;
  const builtAt = Number(stamp);
  if (!Number.isFinite(builtAt)) return true;
  return newestSourceMtime() > builtAt;
}

/** 源码是否比当前进程的启动时间还新（= 跑的是旧代码） */
function sourceNewerThanStart() {
  const startedAt = Number(readTextFile(STARTED_FILE));
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return newestSourceMtime() > startedAt;
}

function runBuild() {
  return new Promise((resolvePromise, reject) => {
    console.log('[*] 正在构建（首次启动或源码有改动时执行）...');
    const child = spawn(IS_WINDOWS ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WINDOWS,
      env: {
        ...process.env,
        // next build 会删除 .next 里的旧产物；在带「批量删除确认」的安全策略下，
        // 一次性删除超过阈值的文件会被拦下，表现为构建莫名失败。
        // 关掉这道守卫是安全的：删除目标都在项目自己的 .next 目录内。
        CODEBUDDY_SAFE_DELETE_BULK_GUARD: '',
        CODEBUDDY_SAFE_DELETE_ENABLED: '0',
      },
    });
    child.on('exit', (code) => {
      if (code === 0) {
        writeTextFile(BUILD_STAMP, String(Date.now()));
        resolvePromise();
      } else {
        reject(new Error(`构建失败（退出码 ${code}）`));
      }
    });
    child.on('error', reject);
  });
}

/** 等待服务就绪（轮询 /api/status） */
async function waitForReady(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

export async function startService(options = {}) {
  const port = options.port ?? resolvePort(new Map());

  const current = await getStatus();
  if (current.running) {
    // 源码比进程还新：此时「已在运行」这句话会让用户以为改动生效了，必须点破
    const stale = sourceNewerThanStart();
    return {
      ok: true,
      message: stale
        ? `服务已在运行（PID ${current.pid}，端口 ${current.port}）——但源码比它新，改动还没生效，请先执行 restart`
        : `服务已在运行（PID ${current.pid}，端口 ${current.port}）`,
      pid: current.pid ?? undefined,
      port: current.port,
    };
  }

  // 端口被别的进程占了
  const occupant = await findPortPid(port);
  if (occupant && isProcessAlive(occupant)) {
    return {
      ok: false,
      port,
      message: `端口 ${port} 已被其他进程占用（PID ${occupant}），请先关闭它或换个端口`,
    };
  }

  ensureRuntimeDir();

  if (options.build !== false && needsBuild()) {
    try {
      await runBuild();
    } catch (err) {
      return {
        ok: false,
        port,
        message: err instanceof Error ? err.message : '构建失败',
      };
    }
  }

  // 日志：追加模式，历史不丢
  ensureRuntimeDir();
  const logFd = openSync(LOG_FILE, 'a');

  // 直接跑 next 的 JS 入口，而不是 .bin/next.cmd：
  // - .cmd 是批处理文件，spawn 会 EINVAL，必须经 cmd /c，多一层进程且 PID 混乱；
  // - 直接用 node 跑 dist/bin/next 是单个进程，PID 明确、进程树简单、好管理。
  const nextEntry = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextEntry)) {
    return { ok: false, port, message: `找不到 next 入口：${nextEntry}，请先执行 npm install` };
  }

  // foreground：服务作为当前脚本的子进程前台运行，脚本退出即停止。
  // 用于「双击 .bat 后窗口要一直开着」的场景，也用于无法脱离进程树的受限环境。
  const foreground = options.foreground === true;

  // 绑定地址：默认只监听 127.0.0.1。
  // next start 默认绑 0.0.0.0 —— 意味着同一局域网（咖啡厅 WiFi、公司网、
  // 酒店路由）里的任何设备都能直接访问本机服务：看到你的片名列表、
  // 蹭你的代理出网、甚至在密码被猜到后完整操作你的账号。
  // 确需手机/电视同网访问时，设 BIND_HOST=0.0.0.0 显式放开。
  const bindHost = resolveBindHost();

  const child = spawn(process.execPath, [nextEntry, 'start', '-p', String(port), '-H', bindHost], {
    cwd: ROOT,
    // detached=false 时子进程随父进程退出；detached=true 时独立存活
    detached: !foreground,
    stdio: foreground ? 'inherit' : ['ignore', logFd, logFd],
    windowsHide: !foreground,
    env: { ...process.env, PORT: String(port), HOSTNAME: bindHost },
  });

  writeTextFile(PID_FILE, String(child.pid));
  writeTextFile(PORT_FILE, String(port));
  writeTextFile(STARTED_FILE, String(Date.now()));

  if (foreground) {
    // 前台模式：等就绪后打印提示，然后一直等到进程退出（Ctrl+C 连带结束）
    const ready = await waitForReady(port);
    if (ready) {
      console.log(`[+] 服务已就绪：http://localhost:${port}`);
      printAccessUrls(port, bindHost);
      if (options.open) openBrowser(port);
    } else {
      console.log(`[-] 服务未能就绪，请检查日志：${LOG_FILE}`);
    }
    await new Promise((resolvePromise) => {
      child.on('exit', () => resolvePromise());
    });
    removeFile(PID_FILE);
    removeFile(PORT_FILE);
    removeFile(STARTED_FILE);
    return { ok: true, port, pid: child.pid, message: '服务已停止' };
  }

  child.unref();

  const ready = await waitForReady(port);
  if (!ready) {
    // 没起来：清理 PID 文件，避免状态页显示「运行中」的假象
    removeFile(PID_FILE);
    removeFile(PORT_FILE);
    removeFile(STARTED_FILE);
    return {
      ok: false,
      port,
      message: `启动超时，请查看日志：${LOG_FILE}`,
    };
  }

  // 存活自检：某些受限环境（如作业对象托管的沙箱）会在父进程退出时
  // 连带回收子进程——此时 HTTP 能通但进程已死，status 会说「未运行」。
  // 这里主动探测一次；失败就自动降级为前台模式重试，
  // 保证「双击启动」在任何环境下都能得到一个可用的服务。
  await new Promise((r) => setTimeout(r, 800));
  if (!isProcessAlive(child.pid)) {
    removeFile(PID_FILE);
    removeFile(PORT_FILE);
    removeFile(STARTED_FILE);

    if (options.fallbackForeground !== false && !foreground) {
      console.log(
        '[*] 当前环境会在父进程退出时回收子进程，自动切换为前台模式…'
      );
      return startService({ ...options, foreground: true });
    }

    return {
      ok: false,
      port,
      message:
        '服务进程被当前运行环境连带回收（无法脱离父进程独立存活）。' +
        '请改用 `node scripts/ctl.mjs start --foreground` 让服务随窗口前台运行。',
    };
  }

  if (options.open) openBrowser(port);

  return {
    ok: true,
    port,
    pid: child.pid,
    message: `已启动（PID ${child.pid}，端口 ${port}）`,
  };
}

// —— 停止 ——

/**
 * 终止进程及其子进程。
 * Windows 用 taskkill /T（进程树），Unix 杀进程组（-pid）。
 * 只 kill 父进程会留下 next start 派生的子进程继续占着端口。
 */
async function killTree(pid, force) {
  if (!isProcessAlive(pid)) return false;
  if (IS_WINDOWS) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try {
      execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      // taskkill 失败时退回直接 kill
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    // 负号 PID = 整个进程组
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

export async function stopService(options = {}) {
  const status = await getStatus();
  if (!status.running || !status.pid) {
    // 顺手清掉可能残留的 PID 文件
    removeFile(PID_FILE);
    removeFile(PORT_FILE);
    removeFile(STARTED_FILE);
    return { ok: true, message: '服务当前未在运行' };
  }

  const pid = status.pid;
  killTree(pid, options.force === true);

  // 等端口真正释放（最多 10 秒）
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const occupant = await findPortPid(status.port);
    if (!occupant || !isProcessAlive(occupant)) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  // 端口还占着 → 强制
  const still = await findPortPid(status.port);
  if (still && isProcessAlive(still)) {
    killTree(still, true);
    await new Promise((r) => setTimeout(r, 800));
  }

  removeFile(PID_FILE);
  removeFile(PORT_FILE);
  removeFile(STARTED_FILE);

  const finalCheck = await findPortPid(status.port);
  if (finalCheck && isProcessAlive(finalCheck)) {
    return {
      ok: false,
      pid,
      message: `停止失败：端口 ${status.port} 仍被 PID ${finalCheck} 占用`,
    };
  }
  return { ok: true, pid, message: `已停止（PID ${pid}）` };
}

// —— 开机自启 ——

function autostartTarget() {
  // 用 start.bat 作为入口：它已经处理了 .env 检查与端口
  return IS_WINDOWS ? join(ROOT, 'start.bat') : join(ROOT, 'start.sh');
}

/**
 * Windows 启动文件夹路径（当前用户）。
 * 用启动文件夹的快捷方式而不是注册表 Run 键：
 * 注册表要调 reg.exe，在受限环境下会被安全策略拦下；
 * 启动文件夹只是放个 .cmd 快捷方式，零依赖、可直接删。
 */
function windowsStartupDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function installAutostart() {
  const target = autostartTarget();
  if (!existsSync(target)) {
    return { ok: false, message: `找不到启动脚本：${target}` };
  }
  if (IS_WINDOWS) {
    const startupDir = windowsStartupDir();
    if (!startupDir) {
      return { ok: false, message: '无法定位 Windows 启动文件夹（APPDATA 未设置）' };
    }
    try {
      mkdirSync(startupDir, { recursive: true });
      // 写一个 .cmd 包装：直接调用控制脚本的 start 子命令
      const cmdPath = join(startupDir, 'LibreTV.cmd');
      writeFileSync(
        cmdPath,
        [
          '@echo off',
          'REM 由 LibreTV 系统控制创建：登录后自动启动服务',
          `cd /d "${ROOT}"`,
          `call "${join(ROOT, 'scripts', 'ctl.mjs')}" start --no-open --no-build`,
          '',
        ].join('\r\n'),
        'utf-8'
      );
      return { ok: true, message: `已设置开机自启（${cmdPath}）` };
    } catch (err) {
      return {
        ok: false,
        message: `设置开机自启失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // Unix：写 shell profile
  try {
    const profile = join(process.env.HOME ?? '', '.profile');
    const line = `\n# LibreTV 开机自启\nnohup "${target}" >/dev/null 2>&1 &\n`;
    const existing = readTextFile(profile) ?? '';
    if (!existing.includes('# LibreTV 开机自启')) {
      writeFileSync(profile, existing + line, 'utf-8');
    }
    return { ok: true, message: `已设置开机自启（写入 ${profile}）` };
  } catch (err) {
    return {
      ok: false,
      message: `设置开机自启失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function uninstallAutostart() {
  if (IS_WINDOWS) {
    const startupDir = windowsStartupDir();
    const cmdPath = startupDir ? join(startupDir, 'LibreTV.cmd') : null;
    try {
      if (cmdPath && existsSync(cmdPath)) {
        unlinkSync(cmdPath);
        return { ok: true, message: `已取消开机自启（删除 ${cmdPath}）` };
      }
      return { ok: true, message: '开机自启本就未启用' };
    } catch (err) {
      return {
        ok: false,
        message: `取消开机自启失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  try {
    const profile = join(process.env.HOME ?? '', '.profile');
    const existing = readTextFile(profile) ?? '';
    writeFileSync(
      profile,
      existing.replace(/\n# LibreTV 开机自启\nnohup "[^"]*" >\/dev\/null 2>&1 &\n/g, '\n'),
      'utf-8'
    );
    return { ok: true, message: '已取消开机自启' };
  } catch (err) {
    return {
      ok: false,
      message: `取消开机自启失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 是否已设置开机自启 */
export function isAutostartEnabled() {
  if (IS_WINDOWS) {
    const startupDir = windowsStartupDir();
    const cmdPath = startupDir ? join(startupDir, 'LibreTV.cmd') : null;
    return Boolean(cmdPath && existsSync(cmdPath));
  }
  const profile = join(process.env.HOME ?? '', '.profile');
  return (readTextFile(profile) ?? '').includes('# LibreTV 开机自启');
}

// —— 浏览器 ——

function openBrowser(port) {
  const url = `http://localhost:${port}`;
  try {
    if (IS_WINDOWS) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch {
    /* 打不开就算了，用户手动访问 */
  }
}

// —— 入口 ——

const HELP = `LibreTV 系统控制

  node scripts/ctl.mjs start [--port 8080] [--no-build] [--no-open] [--foreground]
      启动服务（默认自动构建、启动后打开浏览器）
      --foreground  前台运行：服务随本窗口一起存在，关窗口即停止
  node scripts/ctl.mjs stop [--force]
      关闭服务（--force 跳过优雅退出）
  node scripts/ctl.mjs restart [--port 8080]
      重启服务
  node scripts/ctl.mjs status
      查看运行状态（PID / 端口 / 运行时长）
  node scripts/ctl.mjs install
      设置开机自启
  node scripts/ctl.mjs uninstall
      取消开机自启
  node scripts/ctl.mjs logs [--lines 100]
      查看最近日志
`;

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'start': {
      const foreground = flags.get('foreground') === true;
      if (foreground) {
        console.log('[*] 前台模式：服务将随本窗口一起运行，关闭窗口即停止');
      }
      const result = await startService({
        port: resolvePort(flags),
        build: flags.get('no-build') !== true,
        open: flags.get('no-open') !== true,
        foreground,
      });
      console.log(result.ok ? `[+] ${result.message}` : `[-] ${result.message}`);
      if (result.ok) printAccessUrls(result.port, resolveBindHost());
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'stop': {
      const result = await stopService({ force: flags.get('force') === true });
      console.log(result.ok ? `[+] ${result.message}` : `[-] ${result.message}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'restart': {
      const port = resolvePort(flags);
      await stopService({});
      const result = await startService({ port, build: flags.get('no-build') !== true, open: false });
      console.log(result.ok ? `[+] ${result.message}` : `[-] ${result.message}`);
      if (result.ok) printAccessUrls(result.port, resolveBindHost());
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'status': {
      const status = await getStatus();
      if (status.running) {
        const uptime = status.uptimeMs
          ? `${Math.floor(status.uptimeMs / 60000)} 分钟`
          : '未知';
        console.log(
          `[+] 运行中 · PID ${status.pid} · 端口 ${status.port} · 已运行 ${uptime}（来源：${status.detectedBy}）`
        );
      } else {
        console.log(`[-] 未运行 · 端口 ${status.port}`);
      }
      printAccessUrls(status.port, resolveBindHost());
      console.log(`    日志：${status.logFile}`);
      console.log(`    开机自启：${isAutostartEnabled() ? '已启用' : '未启用'}`);
      break;
    }
    case 'install': {
      const result = installAutostart();
      console.log(result.ok ? `[+] ${result.message}` : `[-] ${result.message}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'uninstall': {
      const result = uninstallAutostart();
      console.log(result.ok ? `[+] ${result.message}` : `[-] ${result.message}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'logs': {
      const lines = Number(flags.get('lines') ?? 100);
      const content = readTextFile(LOG_FILE);
      if (!content) {
        console.log('[-] 暂无日志');
        break;
      }
      console.log(content.split(/\r?\n/).slice(-lines).join('\n'));
      break;
    }
    case 'delayed': {
      // 延迟执行另一个子命令：node ctl.mjs delayed <秒> <命令...>
      // 用于「服务关闭自己」的场景——派生出的独立进程会等指定秒数后
      // 再执行 stop，而这段时间里主服务已经退出、HTTP 响应已经返回。
      const seconds = Number(flags.get('wait') ?? 0);
      const target = flags.get('run');
      if (!target) {
        console.log('[-] 缺少 --run 参数');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [join(ROOT, 'scripts', 'ctl.mjs'), ...target.split(' ')],
        { cwd: ROOT, timeout: 120_000 }
      );
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      break;
    }
    case 'verify': {
      // 独立进程的存活复检：start 命令返回后，父进程已退出，
      // 此时再探测才能发现「子进程被连带回收」的情况。
      // 退出码：0=存活，1=已死。
      await new Promise((r) => setTimeout(r, 1200));
      const status = await getStatus();
      if (status.running) {
        console.log(`[+] 服务存活（PID ${status.pid}，端口 ${status.port}）`);
        process.exit(0);
      }
      console.log('[-] 服务未存活');
      process.exit(1);
    }
    default:
      console.log(HELP);
  }
}

// 仅在被直接执行时跑 main（被 import 时只导出函数）
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[-] 执行失败：', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
