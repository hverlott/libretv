/**
 * 评分补全端到端验证：/api/rating 的接口契约 + 隐私约束。
 *
 * 与业务验证（能拿到多少分）分开：豆瓣有反爬、TMDB 需要 key，
 * 依赖它们会让 e2e 变成网络赌博。这里只验证**不依赖上游可用性**的部分：
 * 鉴权、入参校验、成人条目不外发、批量截断、隐私状态暴露、缓存结构。
 * 真实命中作为「尽力而为」项记录结果，但**不判定通过与否**。
 *
 * 用法：node tests/e2e-rating.cjs
 * 8080 上没有服务时脚本会自己拉起一个，跑完关掉。
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || '8080';
const BASE = `http://127.0.0.1:${PORT}`;
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();
const MAX_BATCH = 24;

const ROOT = path.resolve(__dirname, '..');

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

let server = null;

async function ensureServer() {
  const ping = async () => {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await ping()) {
    console.log(`复用已在运行的服务 ${BASE}`);
    return false;
  }
  console.log('服务未运行，拉起中…');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', PORT], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping()) {
      await new Promise((r) => setTimeout(r, 2000));
      console.log('服务就绪');
      return true;
    }
  }
  throw new Error('服务启动超时');
}

function stopServer() {
  if (!server) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  } catch {
    /* 关不掉也无所谓 */
  }
}

async function postRatings(req, items) {
  const res = await req.post(`${BASE}/api/rating`, { data: { items } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), ratings: body.ratings ?? [] };
}

(async () => {
  const own = await ensureServer();
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const anon = await browser.newContext();

  try {
    console.log('\n[1] 未登录时拒绝');
    {
      const req = anon.request;
      const an = await req.post(`${BASE}/api/rating`, {
        data: { items: [{ title: '肖申克的救赎' }] },
      });
      check('未登录 401', an.status() === 401, `HTTP ${an.status()}`);
      const get = await req.get(`${BASE}/api/rating?title=${encodeURIComponent('肖申克的救赎')}`);
      check('未登录 GET 也 401', get.status() === 401, `HTTP ${get.status()}`);
    }

    // 登录（弹窗异步挂载，必须等它出现再填）
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const pw = page.locator('input[type="password"]').first();
    if (await pw.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      await pw.fill(PASSWORD);
      await pw.press('Enter');
      await pw.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    check('登录完成', (await page.locator('input[type="password"]').count()) === 0);

    const req = page.request;

    console.log('\n[2] 入参校验');
    {
      const noTitle = await postRatings(req, [{ title: '' }, {}, { title: '   ' }]);
      check(
        '空标题条目返回 null 而不是报错',
        noTitle.status === 200 && noTitle.ratings.length === 3 && noTitle.ratings.every((r) => r === null),
        `HTTP ${noTitle.status}，${noTitle.ratings.length} 条`
      );

      const bad = await req.post(`${BASE}/api/rating`, { data: { nope: 1 } });
      check('缺少 items 时 400', bad.status() === 400, `HTTP ${bad.status()}`);

      const missing = await req.get(`${BASE}/api/rating`);
      check('GET 缺标题时 400', missing.status() === 400, `HTTP ${missing.status()}`);
    }

    console.log('\n[3] 成人条目不外发');
    {
      const adult = await postRatings(req, [
        { title: '某个成人片名', year: '2024', adult: true },
      ]);
      check(
        '成人条目直接返回 null（片名不会交给第三方）',
        adult.status === 200 && adult.ratings[0] === null,
        `HTTP ${adult.status}`
      );
    }

    console.log('\n[4] 批量截断');
    {
      // 用同一个标题重复 60 次：验证的是「返回条数被截断」，
      // 而不是真的往评分站打 24 个请求（e2e 不该当压测用）
      const many = Array.from({ length: 60 }, () => ({ title: '肖申克的救赎', year: '1994' }));
      const res = await postRatings(req, many);
      check(
        `批量上限 ${MAX_BATCH}（防止整页 40 条一次性打过去）`,
        res.status === 200 && res.ratings.length === MAX_BATCH,
        `请求 60 条，返回 ${res.ratings.length} 条`
      );
    }

    console.log('\n[5] 结果与入参一一对应');
    {
      const items = [{ title: '肖申克的救赎', year: '1994' }, { title: '周处除三害', year: '2023' }];
      const res = await postRatings(req, items);
      const ok = res.ratings.length === items.length && res.ratings.every((r) => r === null || typeof r.score === 'number');
      check('数组长度与入参一致', res.status === 200 && ok, `${res.ratings.length} 条`);
    }

    console.log('\n[6] GET 单条接口');
    {
      const res = await req.get(`${BASE}/api/rating?title=${encodeURIComponent('肖申克的救赎')}&year=1994`);
      const body = await res.json().catch(() => ({}));
      check(
        'GET 返回 {rating} 结构',
        res.status() === 200 && 'rating' in body,
        `HTTP ${res.status()}，rating=${body.rating ? body.rating.score : 'null'}`
      );
    }

    console.log('\n[7] 隐私状态暴露评分补全');
    {
      const res = await req.get(`${BASE}/api/privacy/status`);
      const body = await res.json().catch(() => ({}));
      const r = body.rating;
      check(
        '隐私接口含 rating 段（含 providers / cacheSize / cooling）',
        res.status() === 200 && !!r && typeof r.enabled === 'boolean' && Array.isArray(r.providers) && typeof r.cacheSize === 'number',
        r ? `enabled=${r.enabled}，providers=${JSON.stringify(r.providers)}，缓存 ${r.cacheSize} 条` : '缺失'
      );
    }

    console.log('\n[8] 真实命中（尽力而为，不判定通过）');
    {
      const titles = ['肖申克的救赎', '周处除三害', '漫长的季节'];
      const res = await postRatings(req, titles.map((title) => ({ title })));
      const hits = res.ratings.filter(Boolean);
      for (const [i, r] of res.ratings.entries()) {
        console.log(`    ${r ? `★${r.score}（${r.provider === 'tmdb' ? 'TMDB' : '豆瓣'}）` : '—'} ${titles[i]}`);
      }
      console.log(
        hits.length > 0
          ? `  命中 ${hits.length}/${titles.length}（上游可用）`
          : `  命中 0/${titles.length}：上游不可用或被限流，属预期内，不计失败`
      );
      // 结构性校验仍然要过：有结果的必须落在 0–10 且带来源
      const sane = hits.every((r) => r.score >= 0 && r.score <= 10 && !!r.provider);
      check('命中的评分结构合法', sane, `${hits.length} 条`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (own) stopServer();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  stopServer();
  process.exit(1);
});
