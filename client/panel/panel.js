'use strict';

/**
 * 控制面板逻辑：轮询状态、启停服务、进入系统。
 *
 * 所有请求都打同源的 /api/*，避免跨域；
 * 「进入系统」用同源导航到 /app/（面板服务会反代到 LibreTV），
 * 这样播放器与面板同源——全屏、Cookie、跨域策略都正常。
 */
const $ = (id) => document.getElementById(id);

const els = {
  dot: $('dot'),
  statusTitle: $('statusTitle'),
  statusNote: $('statusNote'),
  hdrSub: $('hdrSub'),
  fUrl: $('fUrl'),
  fPort: $('fPort'),
  fPid: $('fPid'),
  fUptime: $('fUptime'),
  fDetected: $('fDetected'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnRestart: $('btnRestart'),
  btnBrowser: $('btnBrowser'),
  btnEnter: $('btnEnter'),
  btnLogs: $('btnLogs'),
  launchSub: $('launchSub'),
  toast: $('toast'),
  log: $('log'),
  footVer: $('footVer'),
  footRoot: $('footRoot'),
};

let busy = false;
let lastStatus = null;

function formatUptime(ms) {
  if (ms === null || ms === undefined) return '未知';
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec % 60} 秒`;
  return `${sec} 秒`;
}

function showToast(text, kind = 'info') {
  els.toast.textContent = text;
  els.toast.className = `toast show ${kind}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.className = 'toast';
  }, kind === 'err' ? 9000 : 4000);
}

function renderStatus(status) {
  lastStatus = status;
  const running = status?.running ?? false;

  els.dot.className = `dot ${running ? 'on' : ''}`;
  els.statusTitle.textContent = running ? '服务运行中' : '服务已停止';

  els.fUrl.textContent = `http://localhost:${status?.port ?? 8080}`;
  els.fPort.textContent = String(status?.port ?? '—');
  els.fPid.textContent = status?.pid ? String(status.pid) : '—';
  els.fUptime.textContent = running ? formatUptime(status?.uptimeMs) : '—';
  els.fDetected.textContent =
    status?.detectedBy === 'pid-file'
      ? 'PID 文件'
      : status?.detectedBy === 'port'
        ? '端口探测'
        : '—';

  els.hdrSub.textContent = running
    ? `运行中 · 端口 ${status.port}${status.pid ? ` · PID ${status.pid}` : ''}`
    : '服务未运行';

  els.statusNote.textContent = running ? '' : '点击「开启服务」启动';

  els.btnStart.disabled = busy || running;
  els.btnStop.disabled = busy || !running;
  els.btnRestart.disabled = busy || !running;
  els.btnBrowser.disabled = busy || !running;
  els.btnEnter.disabled = busy || !running;
  els.launchSub.textContent = running
    ? '在客户端窗口内打开 LibreTV 播放器'
    : '服务未运行，启动后即可进入';
}

function setBusy(on) {
  busy = on;
  if (on) {
    els.dot.className = 'dot busy';
    els.btnStart.disabled = true;
    els.btnStop.disabled = true;
    els.btnRestart.disabled = true;
    els.btnEnter.disabled = true;
  } else {
    void refresh();
  }
}

async function refresh() {
  try {
    const res = await fetch('/panel-api/status', { cache: 'no-store' });
    const status = await res.json();
    renderStatus(status);
  } catch (err) {
    els.statusTitle.textContent = '无法获取状态';
    els.hdrSub.textContent = String(err?.message ?? err);
  }
}

async function refreshLogs() {
  try {
    const res = await fetch('/panel-api/logs?lines=120', { cache: 'no-store' });
    const data = await res.json();
    els.log.textContent = data?.text || '（暂无日志）';
    els.log.scrollTop = els.log.scrollHeight;
  } catch {
    els.log.textContent = '（读取日志失败）';
  }
}

async function callApi(path, busyLabel) {
  setBusy(true);
  showToast(busyLabel, 'info');
  try {
    const res = await fetch(path, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data?.message || '操作失败', 'err');
      return;
    }
    showToast(data.message || '操作完成', 'ok');
    if (data.status) renderStatus(data.status);
    void refreshLogs();
  } catch (err) {
    showToast(err instanceof Error ? err.message : '操作失败', 'err');
  } finally {
    setBusy(false);
  }
}

els.btnStart.addEventListener('click', () => callApi('/panel-api/start', '正在启动服务…'));
els.btnStop.addEventListener('click', () => callApi('/panel-api/stop', '正在关闭服务…'));
els.btnRestart.addEventListener('click', () => callApi('/panel-api/restart', '正在重启服务…'));

els.btnBrowser.addEventListener('click', () => {
  const port = lastStatus?.port ?? 8080;
  window.open(`http://localhost:${port}/`, '_blank', 'noopener');
});

els.btnEnter.addEventListener('click', () => {
  // 同源导航到反代路径：播放器与面板同源，全屏/Cookie 都正常
  window.location.href = '/app/';
});

els.btnLogs.addEventListener('click', () => void refreshLogs());

// 初始化
(async () => {
  els.footVer.textContent = `LibreTV 客户端 · 面板端口 ${location.port}`;
  await refresh();
  void refreshLogs();
  setInterval(() => {
    if (!busy) void refresh();
  }, 3000);
})();
