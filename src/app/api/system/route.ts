import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLanInfo, resolveBindHost } from '@/lib/lan-access';
import { getEnvFileValue } from '@/lib/env-file';

export const runtime = 'nodejs';

/**
 * 系统控制接口：查看状态 / 启动 / 停止 / 重启。
 *
 * 「停止」的难点：服务无法直接关闭自己（请求还在处理中）。
 * 解法是派生一个**独立的延迟执行进程**：
 * 它不属于本请求的生命周期，等 1.5 秒后（此时 HTTP 响应已返回）再终止服务。
 * 这样用户点「关闭」后页面能正常提示，1.5 秒后服务真的停下。
 *
 * 「启动」用同样的思路反向操作：派一个进程在 2 秒后拉起新服务，
 * 同时当前服务退出——否则端口被占着，新进程起不来。
 */

const RUNTIME_DIR = join(process.cwd(), '.runtime');
const PID_FILE = join(RUNTIME_DIR, 'libretv.pid');
const PORT_FILE = join(RUNTIME_DIR, 'libretv.port');
const STARTED_FILE = join(RUNTIME_DIR, 'libretv.started');
const CTL_SCRIPT = join(process.cwd(), 'scripts', 'ctl.mjs');

/** 站内控制页用的端口：默认与主服务一致 */
function servicePort(): number {
  // 进程自身的 PORT 最准：手机上（Termux）不会生成 .runtime/libretv.port
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    if (existsSync(PORT_FILE)) {
      const p = Number(readFileSync(PORT_FILE, 'utf-8').trim());
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {
    /* 忽略 */
  }
  return 8080;
}

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = Number(readFileSync(PID_FILE, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface SystemStatusResponse {
  running: boolean;
  pid: number | null;
  port: number;
  /** 已运行毫秒数；取不到时为 null */
  uptimeMs: number | null;
  startedAt: number | null;
  /** 当前进程所在部署目录 */
  root: string;
  /** 开机自启是否已启用 */
  autostart: boolean;
  /** Node 版本 */
  nodeVersion: string;
  /** 平台 */
  platform: string;
}

function getStatus(): SystemStatusResponse {
  const port = servicePort();

  /**
   * 这个函数运行在服务进程内部 —— 能处理这个请求，就证明服务本身在运行。
   * 因此用 process 自身的 pid / uptime 判断，比读 .runtime/libretv.pid 可靠得多：
   * 那个 pid 文件只有 Windows 的 ctl.mjs 会写，手机上由 Termux:Boot 直接拉起 node，
   * 从来不会有这个文件，原来会误报「未运行」。
   */
  const selfPid = process.pid;
  const selfUptimeMs = Math.round(process.uptime() * 1000);

  // startedAt 优先取 ctl.mjs 写的启动时间（托管场景更精确），否则按 uptime 反推
  let startedAt = Date.now() - selfUptimeMs;
  try {
    if (existsSync(STARTED_FILE)) {
      const t = Number(readFileSync(STARTED_FILE, 'utf-8').trim());
      if (Number.isFinite(t) && t > 0) startedAt = t;
    }
  } catch {
    /* 忽略 */
  }

  return {
    running: true,
    pid: selfPid,
    port,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    root: process.cwd(),
    autostart: isAutostartEnabled(),
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * 开机自启检测：Windows 看启动文件夹里的快捷脚本，
 * Unix 看 shell profile 里的标记行。
 * 不用注册表是因为受限环境下 reg.exe 会被安全策略拦下。
 */
function isAutostartEnabled(): boolean {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return false;
    const startupDir = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    return existsSync(join(startupDir, 'LibreTV.cmd'));
  }
  // Termux：开机自启由 Termux:Boot 负责（~/.termux/boot/*.sh），与 .profile 无关
  if (process.platform === 'android') {
    const bootDir = join(process.env.HOME ?? '', '.termux', 'boot');
    try {
      if (existsSync(bootDir)) {
        return readdirSync(bootDir).some((f) => f.endsWith('.sh'));
      }
    } catch {
      /* 忽略 */
    }
    return false;
  }
  const profile = join(process.env.HOME ?? '', '.profile');
  try {
    if (existsSync(profile)) {
      return readFileSync(profile, 'utf-8').includes('# LibreTV 开机自启');
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

/**
 * 派一个脱离当前请求的进程去执行后续动作。
 *
 * 关键：这个进程必须**独立于本请求的生命周期**——它要活过本服务的退出。
 * 做法是 detached + 自己的延时逻辑（ctl.mjs delayed），
 * 而不是在本进程里 setTimeout（那会在服务退出时一并消失）。
 */
function spawnDelayed(command: string, delaySeconds: number): void {
  try {
    const child = spawn(
      process.execPath,
      [CTL_SCRIPT, 'delayed', '--wait', String(delaySeconds), '--run', command],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      }
    );
    child.unref();
  } catch {
    /* 忽略 */
  }
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const status = getStatus();
  // 实际监听端口以运行中的进程为准：getStatus() 读的是「配置里的端口」，
  // 用 --port 临时改过端口时两者会不一致，而局域网 URL 必须指向真正能连上的那个
  const servingPort = Number(process.env.PORT) || status.port;

  /**
   * 当前绑定的地址来自进程启动时的环境变量，改完 .env 不会立刻反映。
   * 于是可能出现「配置里写着 LAN_ACCESS=1、实际还绑着 127.0.0.1」的状态——
   * 用户点完开关刷新页面，如果只显示当前绑定，就会以为已经生效。
   * 这里把「配置目标」也算一份，两者不一致 = 待重启。
   */
  const current = getLanInfo(servingPort);
  const fileEnv = {
    LAN_ACCESS: getEnvFileValue('LAN_ACCESS'),
    BIND_HOST: getEnvFileValue('BIND_HOST'),
  };
  const target = getLanInfo(servingPort, { env: { ...process.env, ...fileEnv } });

  return NextResponse.json({
    ...status,
    port: servingPort,
    // 局域网访问信息放这里而不是 /api/status：
    // 后者是未登录可读的公开接口，不该把本机内网地址摊给任何访问者
    lan: {
      ...current,
      /** 配置文件里的目标绑定地址 */
      configuredBindHost: resolveBindHost(fileEnv),
      /** 目标状态是否开放 */
      configuredEnabled: target.enabled,
      /** 配置目标与当前实际绑定不一致 = 改了还没重启 */
      pendingRestart: target.bindHost !== current.bindHost,
      /** 重启后才可用的地址（让用户提前知道该在手机上输什么） */
      targetUrls: target.urls,
    },
  });
}

/**
 * POST /api/system
 * body: { action: 'start' | 'stop' | 'restart' }
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const action = body.action;
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return NextResponse.json({ error: 'action 必须是 start / stop / restart' }, { status: 400 });
  }

  const status = getStatus();

  /**
   * 手机（Termux）上不能走 ctl.mjs：它是 Windows 专用实现（taskkill / 启动文件夹）。
   * 与其点了没反应，不如直接说清该怎么做。
   */
  if (process.platform === 'android' && action !== 'start') {
    return NextResponse.json(
      {
        ok: false,
        error:
          action === 'stop'
            ? '手机上请打开 Termux：pkill -f start-server.sh && pkill -9 -f next-server'
            : '手机上请打开 Termux 执行：lbr（重启）',
        status,
      },
      { status: 501 }
    );
  }

  if (action === 'stop') {
    if (!status.running) {
      return NextResponse.json({ ok: true, message: '服务当前未在运行', status });
    }
    // 派一个独立进程：等服务停掉后（HTTP 响应已返回）再执行关闭
    spawnDelayed('stop', 2);
    return NextResponse.json({
      ok: true,
      message: '正在关闭，服务将在约 2 秒后停止',
      status,
    });
  }

  if (action === 'restart' || action === 'start') {
    if (status.running && action === 'start') {
      return NextResponse.json({ ok: true, message: '服务已在运行', status });
    }
    // 重启：先停，再由独立进程拉起新的
    // 独立进程需要在服务退出后仍存活，因此用「先停服务、稍后由外部再启动」的两段式：
    // 这里只负责停；启动交给 start.bat / 控制脚本。
    if (action === 'restart') {
      spawnDelayed('stop', 2);
      return NextResponse.json({
        ok: true,
        message: '正在重启：服务将停止，请用「启动系统」重新拉起（或等待自动重启）',
        status,
      });
    }
    return NextResponse.json({
      ok: false,
      error: '服务未运行时无法从站内启动（没有进程来执行这个请求）。请双击「启动系统.bat」',
      status,
    });
  }

  return NextResponse.json({ error: '未知操作' }, { status: 400 });
}
