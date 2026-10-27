'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * 系统控制页：一键开启 / 关闭 LibreTV。
 *
 * 与「启动系统.bat / 停止系统.bat」是同一套能力的两个入口：
 * - 桌面双击：完全脱离浏览器，适合开机后手动拉起；
 * - 站内页面：随手一点，适合运行中想重启或看状态。
 *
 * 关闭的时序：点「关闭」→ 服务返回响应 → 独立进程等 2 秒 → 终止服务。
 * 页面会在此期间提示「即将关闭」，然后跳转到「已关闭」页。
 */

interface SystemLanInfo {
  /** 是否允许本机以外的设备访问 */
  enabled: boolean;
  bindHost: string;
  port: number;
  /** 局域网内可直接使用的地址 */
  addresses: string[];
  /** 拼好的完整 URL */
  urls: string[];
  passwordConfigured: boolean;
  /** 密码偏弱（开局域网时才有安全意义） */
  passwordWeak: boolean;
  /** .env 里的目标绑定地址 */
  configuredBindHost: string;
  /** 目标是否开放（与 enabled 不同 = 改了还没重启） */
  configuredEnabled: boolean;
  /** 配置与当前实际绑定不一致 */
  pendingRestart: boolean;
  /** 重启后才可用的地址 */
  targetUrls: string[];
}

interface SystemStatus {
  running: boolean;
  pid: number | null;
  port: number;
  uptimeMs: number | null;
  startedAt: number | null;
  root: string;
  autostart: boolean;
  nodeVersion: string;
  platform: string;
  lan?: SystemLanInfo;
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '未知';
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec % 60} 秒`;
  return `${sec} 秒`;
}

export default function SystemPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/system', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SystemStatus;
      setStatus(data);
    } catch {
      // 服务停掉后请求会失败（浏览器报网络错误），这本身也是一种状态
      setStatus((prev) =>
        prev
          ? { ...prev, running: false, pid: null, uptimeMs: null }
          : null
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    pollRef.current = setInterval(() => void load(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  // 服务关闭过程中持续探测：一旦连不上，说明已经停掉了
  useEffect(() => {
    if (!stopping) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch('/api/system', { cache: 'no-store' });
          if (!res.ok) throw new Error('down');
        } catch {
          setStopping(false);
          setStatus((prev) =>
            prev ? { ...prev, running: false, pid: null, uptimeMs: null } : null
          );
          toast('服务已关闭', 'success');
        }
      })();
    }, 1000);
    return () => clearInterval(timer);
  }, [stopping, toast]);

  const act = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      const res = await fetch('/api/system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data?.error || '操作失败', 'error');
        return;
      }
      if (action === 'stop' || action === 'restart') {
        setStopping(true);
        toast(data.message || '服务将在约 2 秒后停止', 'info');
      } else {
        toast(data.message || '操作完成', 'success');
        void load();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleLan = async (enabled: boolean) => {
    setLanBusy(true);
    try {
      const res = await fetch('/api/system/lan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data?.error || '保存失败', 'error');
        return;
      }
      // 重新拉一次状态：服务端会把「配置目标 vs 当前绑定」的差异算成 pendingRestart，
      // 这样刷新页面也不会丢掉「待重启」提示
      void load();
      if (data.overriddenByBindHost) {
        toast(`已写入 LAN_ACCESS，但 .env 里的 BIND_HOST=${data.bindHost} 会覆盖它`, 'warning');
      } else {
        toast(enabled ? '已开启，重启服务后生效' : '已关闭，重启服务后生效', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setLanBusy(false);
    }
  };

  const running = status?.running ?? false;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-2">系统控制</h1>
          <p className="text-sm text-muted leading-relaxed">
            一键开启或关闭 LibreTV 服务。关闭后本页面会断开，属正常现象——
            需要再开启时，双击项目目录下的「启动系统.bat」即可。
          </p>
        </section>

        {/* 状态卡片 */}
        <section className="card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block w-2.5 h-2.5 rounded-full',
                running ? 'bg-green-500' : 'bg-faint'
              )}
              aria-hidden
            />
            <span className="text-base font-semibold text-content">
              {loading ? '检测中…' : running ? '服务运行中' : '服务已停止'}
            </span>
          </div>

          {status && (
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <Info label="端口" value={String(status.port)} />
              <Info label="进程 PID" value={status.pid ? String(status.pid) : '—'} />
              <Info label="已运行" value={formatUptime(status.uptimeMs)} />
              <Info label="Node" value={status.nodeVersion} />
              <Info label="平台" value={status.platform} />
              <Info label="开机自启" value={status.autostart ? '已启用' : '未启用'} />
            </dl>
          )}

          {status && (
            <p className="text-xs text-faint break-all">
              部署目录：{status.root}
            </p>
          )}
        </section>

        {/* 操作按钮 */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              disabled={busy !== null || running || stopping}
              onClick={() => void act('start')}
              title="启动服务（服务未运行时，站内无法启动——请用「启动系统.bat」）"
            >
              {busy === 'start' ? '启动中…' : '开启服务'}
            </button>
            <button
              className="btn-ghost"
              disabled={busy !== null || !running || stopping}
              onClick={() => void act('stop')}
              title="关闭服务"
            >
              {busy === 'stop' ? '关闭中…' : '关闭服务'}
            </button>
            <button
              className="btn-ghost"
              disabled={busy !== null || !running || stopping}
              onClick={() => void act('restart')}
              title="关闭后需用「启动系统.bat」重新拉起"
            >
              {busy === 'restart' ? '重启中…' : '重启服务'}
            </button>
          </div>

          {stopping && (
            <p className="text-xs text-warning bg-chip rounded-lg px-3 py-2">
              服务正在关闭，本页面即将断开。稍候用「启动系统.bat」重新开启。
            </p>
          )}

          {!running && !stopping && (
            <p className="text-xs text-faint bg-chip rounded-lg px-3 py-2">
              服务未运行时，站内无法执行「开启」——因为没有进程来响应这个请求。
              请双击项目目录下的「启动系统.bat」。
            </p>
          )}
        </section>

        {/* 局域网访问 */}
        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">局域网访问</h2>
          <LanPanel
            lan={status?.lan}
            busy={lanBusy}
            onToggle={toggleLan}
            onRestart={() => act('restart')}
            onCopied={(text) => toast(`已复制：${text}`, 'success')}
          />
        </section>

        {/* 桌面入口说明 */}
        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">桌面快捷操作</h2>
          <p className="text-sm text-muted leading-relaxed mb-2.5">
            项目目录下有三个可双击运行的脚本：
          </p>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">启动系统.bat</code> — 启动服务，后台运行</li>
            <li><code className="text-accent">停止系统.bat</code> — 停止服务（按进程树终止，不留孤儿进程）</li>
            <li><code className="text-accent">查看状态.bat</code> — 查看 PID / 端口 / 运行时长</li>
          </ul>
          <p className="text-sm text-muted leading-relaxed mt-2.5">
            也可以用命令行：
            <code className="text-accent text-xs"> node scripts/ctl.mjs start|stop|restart|status|logs</code>
          </p>
        </section>

        {/* 说明 */}
        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">关于「关闭后如何再开启」</h2>
          <p className="text-sm text-muted leading-relaxed">
            关闭服务后，运行服务的进程本身就消失了，自然也没有进程能重新拉起自己。
            因此「开启」这一步必须由外部发起——双击「启动系统.bat」，
            或在命令行执行 <code className="text-accent text-xs">npm start</code>。
            这是自托管服务的固有约束，不是本页面的限制。
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="text-sm text-content truncate">{value}</dd>
    </div>
  );
}

/**
 * 局域网访问面板。
 *
 * 默认（仅本机）时给出开启步骤；已开启时列出可直接输入的地址。
 * 密码偏弱必须显式告警——开启局域网后密码就是唯一防线，
 * 而「libretv」这种默认值在家庭网络里几乎等于没有防线。
 */
function LanPanel({
  lan,
  busy,
  onToggle,
  onRestart,
  onCopied,
}: {
  lan?: SystemLanInfo;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRestart: () => void;
  onCopied: (text: string) => void;
}) {
  const copy = async (text: string) => {
    if (await copyToClipboard(text)) onCopied(text);
  };

  if (!lan) return <p className="text-sm text-faint">读取中…</p>;

  // 按钮跟着「配置目标」走而不是当前绑定：点了开关但还没重启时，
  // 按钮应该已经变成「关闭」，否则用户会以为没点成功而反复点
  const targetOn = lan.configuredEnabled;
  const urls = lan.enabled ? lan.urls : lan.pendingRestart && targetOn ? lan.targetUrls : [];

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-content">
            {lan.enabled
              ? '已开启：同一网络下的设备可以访问'
              : targetOn
                ? '配置已开启，等待重启生效'
                : '当前仅本机可访问'}
          </p>
          <p className="text-xs text-faint mt-0.5 font-mono">
            {lan.pendingRestart
              ? `当前监听 ${lan.bindHost}:${lan.port} → 重启后 ${lan.configuredBindHost}:${lan.port}`
              : `监听 ${lan.bindHost}:${lan.port}`}
          </p>
        </div>
        <button
          type="button"
          className={cn('btn btn-sm shrink-0', targetOn ? 'btn-ghost' : 'btn-primary')}
          disabled={busy}
          onClick={() => onToggle(!targetOn)}
        >
          {busy ? '保存中…' : targetOn ? '关闭局域网访问' : '开启局域网访问'}
        </button>
      </div>

      {lan.pendingRestart && (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2.5 text-xs leading-relaxed">
          <span className="font-medium text-content">配置已写入 .env，重启后生效。</span>
          <span className="text-muted">
            {targetOn
              ? ' 重启后同网段的设备就能访问了。'
              : ' 重启后会退回到仅本机可访问。'}
          </span>
          <button type="button" className="ml-2 underline text-accent" onClick={onRestart}>
            立即重启
          </button>
        </div>
      )}

      {urls.length > 0 && (
        <div className="space-y-1.5">
          {!lan.enabled && (
            <p className="text-xs text-faint">重启后可用下面的地址访问：</p>
          )}
          {urls.map((url) => (
            <button
              key={url}
              type="button"
              className="w-full flex items-center justify-between gap-3 rounded-md bg-chip px-3 py-2 text-left hover:bg-hover transition-colors"
              onClick={() => copy(url)}
              title="点击复制"
            >
              <span className="font-mono text-sm text-content truncate">{url}</span>
              <span className="text-xs text-faint shrink-0">复制</span>
            </button>
          ))}
        </div>
      )}

      {lan.enabled && urls.length === 0 && (
        <p className="text-sm text-faint leading-relaxed">
          没有检测到可用的局域网 IPv4 地址。请确认这台机器已连上 Wi-Fi 或有线网络。
        </p>
      )}

      {targetOn && lan.passwordWeak && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          <span className="font-medium">密码偏弱：</span>
          同一网络下的任何设备都能访问这个服务，密码是唯一防线。
          当前密码少于 8 位或属于常见口令，建议改成一段较长的自有口令
          （项目目录 .env 里的 <code>PASSWORD</code>，改完需重启）。
        </div>
      )}

      {targetOn && !lan.passwordConfigured && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:text-red-300">
          <span className="font-medium">尚未设置访问密码：</span>
          当前全站无鉴权，局域网内任何人都能直接使用。请先在 .env 里设置 <code>PASSWORD</code>。
        </div>
      )}

      {targetOn && (
        <p className="text-xs text-faint leading-relaxed">
          手机仍打不开时，多半是 Windows 防火墙拦了入站连接：
          双击项目目录下的「放行防火墙.bat」（需管理员权限），或手动放行 TCP {lan.port} 端口。
        </p>
      )}

      {!targetOn && (
        <p className="text-xs text-faint leading-relaxed">
          开启后同网段的手机 / 电视 / 平板可用 <span className="font-mono">http://本机IP:{lan.port}</span> 访问。
          代价是同网段的任何设备都能连到本服务，密码成为唯一防线；
          需要绑到某张特定网卡时，改用 .env 里的 <code>BIND_HOST</code> 指定 IP。
        </p>
      )}
    </div>
  );
}
