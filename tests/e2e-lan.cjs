/**
 * 局域网访问端到端验证。
 *
 * 验的是「别的设备真的连得上」这件事，而不是页面长什么样：
 * - 服务绑 0.0.0.0 后，用**本机的局域网 IP**（不是 127.0.0.1）访问首页要能通
 *   —— 这一步同时证明了 socket 确实绑在对外网卡上；
 * - 局域网访问不等于免鉴权：未登录访问 /api/system 仍然 401；
 * - /api/system 能告诉用户「该在手机上输入哪个地址」；
 * - 系统页的开关能把 LAN_ACCESS 写进 .env（写完原样恢复，不能污染用户配置）；
 * - ctl.mjs 的 status 输出里要出现局域网地址。
 *
 * 用法：node tests/e2e-lan.cjs
 * 自己起一个独立端口的服务，跑完关掉；.env 会备份并原样还原。
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '8096';
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();
const BASE = `http://127.0.0.1:${PORT}`;
const ENV_PATH = path.join(ROOT, '.env');
const ENV_BACKUP = path.join(ROOT, '.env.e2e-backup');

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

let server = null;

function lanIp() {
  const ifaces = networkInterfaces();
  const candidates = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      candidates.push(info.address);
    }
  }
  // 私有网段优先，和 src/lib/lan-access.ts 的排序保持一致
  const priv = candidates.filter(
    (ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
  return (priv[0] || candidates[0]) || null;
}

async function waitReady(url, tries = 90) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* 继续等 */
    }
  }
  return false;
}

function stopServer() {
  if (!server) return;
  try {
    spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  server = null;
}

function restoreEnv() {
  if (!existsSync(ENV_BACKUP)) return;
  try {
    copyFileSync(ENV_BACKUP, ENV_PATH);
    unlinkSync(ENV_BACKUP);
  } catch {
    /* 忽略 */
  }
}

(async () => {
  const ip = lanIp();
  console.log(`本机局域网 IP：${ip || '（未检测到）'}`);

  // .env 备份：下面的开关测试会改它，必须原样还原
  const hadEnv = existsSync(ENV_PATH);
  if (hadEnv) copyFileSync(ENV_PATH, ENV_BACKUP);

  console.log('\n[1] 以「允许局域网」方式启动');
  server = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', PORT, '-H', '0.0.0.0'],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, LAN_ACCESS: '1', PORT },
    }
  );
  const ready = await waitReady(`${BASE}/api/status`);
  check('服务已启动', ready);
  if (!ready) throw new Error('服务未就绪');

  try {
    console.log('\n[2] 绑定与可达性');
    {
      const local = await fetch(`${BASE}/api/status`).then((r) => r.status).catch(() => 0);
      check('localhost 可访问', local === 200, `HTTP ${local}`);

      if (!ip) {
        check('局域网 IP 可访问', false, '本机没有可用的局域网 IPv4');
      } else {
        let status = 0;
        try {
          const res = await fetch(`http://${ip}:${PORT}/api/status`, {
            signal: AbortSignal.timeout(5000),
          });
          status = res.status;
        } catch (err) {
          status = 0;
          console.log(`    连接失败：${err.message}`);
        }
        check(
          '局域网 IP 可访问（证明绑定在对外网卡上）',
          status === 200,
          `http://${ip}:${PORT} → HTTP ${status}`
        );
      }
    }

    console.log('\n[3] 局域网访问不免鉴权');
    {
      let anon = 0;
      try {
        const res = await fetch(`http://${ip || '127.0.0.1'}:${PORT}/api/system`, {
          signal: AbortSignal.timeout(5000),
        });
        anon = res.status;
      } catch {
        anon = 0;
      }
      check('未登录访问 /api/system 仍是 401', anon === 401, `HTTP ${anon}`);
    }

    console.log('\n[4] 登录后拿到局域网地址');
    const login = await fetch(`${BASE}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('登录成功', login.status === 200 && cookie.length > 0, `HTTP ${login.status}`);
    if (!cookie) throw new Error('登录失败，后续检查无法进行');

    {
      const res = await fetch(`${BASE}/api/system`, { headers: { cookie } });
      const body = await res.json().catch(() => ({}));
      const lan = body.lan;
      check('返回 lan 信息', Boolean(lan), lan ? `enabled=${lan.enabled}` : '缺失');
      check('lan.enabled = true', lan?.enabled === true);
      check('lan.bindHost = 0.0.0.0', lan?.bindHost === '0.0.0.0', lan?.bindHost);
      const urls = lan?.urls ?? [];
      check(
        '列出了可访问的局域网 URL',
        urls.length > 0 && urls.every((u) => u.startsWith('http://')),
        urls.join(', ') || '空'
      );
      if (ip) {
        check('URL 里包含本机局域网 IP', urls.some((u) => u.includes(ip)), urls.join(', '));
      }
      check(
        '给出密码强度信号（弱密码要能提示）',
        typeof lan?.passwordWeak === 'boolean' && typeof lan?.passwordConfigured === 'boolean'
      );
    }

    console.log('\n[5] 系统页开关能写 .env（并原样还原）');
    {
      const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
      const before = /^LAN_ACCESS\s*=/m.test(original) ? original.match(/^LAN_ACCESS\s*=\s*(.*)$/m)[1].trim() : null;
      const target = before === '1' ? false : true;

      const res = await fetch(`${BASE}/api/system/lan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ enabled: target }),
      });
      const body = await res.json().catch(() => ({}));
      check('开关接口返回成功', res.status === 200 && body.saved === true, `HTTP ${res.status}`);
      check('提示需要重启才生效', body.restartRequired === true);

      const after = readFileSync(ENV_PATH, 'utf8');
      const written = after.match(/^LAN_ACCESS\s*=\s*(.*)$/m);
      check(
        '.env 里 LAN_ACCESS 已更新',
        Boolean(written) && written[1].trim() === (target ? '1' : '0'),
        written ? `LAN_ACCESS=${written[1].trim()}` : '未找到该键'
      );
      check('其余配置未被破坏', after.includes('PASSWORD=') || !original.includes('PASSWORD='));

      // 立刻还原，避免影响真实启动配置
      restoreEnv();
      const restored = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
      check('.env 已还原', restored === original);
    }

    console.log('\n[5b] 改了配置但没重启时，要能看出来');
    {
      // 当前进程以 LAN_ACCESS=1 启动（绑定 0.0.0.0），这里把 .env 改成 0，
      // 模拟「用户点了开关但还没重启」——页面必须显示待重启，而不是假装已生效
      const before = readFileSync(ENV_PATH, 'utf8');
      writeFileSync(ENV_PATH, before.replace(/^LAN_ACCESS=.*$/m, 'LAN_ACCESS=0'), 'utf8');
      try {
        const res = await fetch(`${BASE}/api/system`, { headers: { cookie } });
        const lan = (await res.json()).lan ?? {};
        check('enabled 仍反映当前进程（true）', lan.enabled === true);
        check('configuredEnabled 反映配置目标（false）', lan.configuredEnabled === false);
        check('pendingRestart = true', lan.pendingRestart === true, `bindHost=${lan.bindHost}`);
      } finally {
        writeFileSync(ENV_PATH, before, 'utf8');
      }
    }

    console.log('\n[6] ctl.mjs 的状态输出带局域网地址');
    {
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/ctl.mjs', 'status'], {
          cwd: ROOT,
          env: { ...process.env, LAN_ACCESS: '1', PORT },
        });
        let text = '';
        child.stdout.on('data', (d) => (text += d.toString()));
        child.stderr.on('data', (d) => (text += d.toString()));
        child.on('close', () => resolve(text));
        setTimeout(() => resolve(text), 15000);
      });
      check('输出里出现「局域网：」', out.includes('局域网：'), out.split('\n').slice(1, 4).join(' / '));
    }
    console.log('\n[7] 系统页上的局域网面板');
    {
      const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
      try {
        const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
        // 直接注入登录后的会话 Cookie，省掉再走一遍登录弹窗
        await ctx.addCookies([
          { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE },
        ]);
        const page = await ctx.newPage();
        await page.goto(`${BASE}/system`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        const text = await page.locator('body').innerText();
        check('页面出现「局域网访问」区块', text.includes('局域网访问'));
        check('显示当前监听地址', /监听\s*0\.0\.0\.0/.test(text), text.match(/监听[^\n]*/)?.[0] ?? '');
        const toggle = page.locator('button', { hasText: /局域网访问$/ }).first();
        check('存在开关按钮', (await toggle.count()) > 0, (await toggle.innerText().catch(() => '')) || '');
        const urlButtons = page.locator('button').filter({ hasText: 'http://' });
        check('列出可复制的访问地址', (await urlButtons.count()) > 0);
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    restoreEnv();
    stopServer();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  restoreEnv();
  stopServer();
  process.exit(1);
});
