/**
 * 漫画「限制级（pornographic）」分级端到端验证：Playwright + 系统 Edge。
 *
 * 与 `e2e-manga-regions.cjs` 的分工：那边测地区与成人向档位，
 * 这边测新开放的**限制级**档位，重点验证三件事：
 *
 * 1. 档位**向下累积**（pornographic 包含 erotica，erotica 不含 pornographic）；
 * 2. 放开限制级后，`BLOCKED_TAGS`（未成年性化题材）**依然被硬排除**；
 * 3. 详情与章节接口必须带同一档位——限制级作品的 feed 不带档位会返回 0 章。
 *
 * 用法：node tests/e2e-manga-ratings.cjs
 * 8080 上没有服务时脚本会自己拉起一个，跑完关掉。
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || '8080';
const BASE = `http://127.0.0.1:${PORT}`;
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

const ROOT = path.resolve(__dirname, '..');
const BLOCKED = new Set(['Loli', 'Shota', 'Incest']);

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

let server = null;

/** 服务没起就自己拉一个，返回是否是本脚本拉起的 */
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
      // next start 首请求要编译，再等一会
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
    /* 关不掉也无所谓，进程随脚本退出 */
  }
}

async function browse(page, qs) {
  const res = await page.request.get(`${BASE}/api/manga/browse?source=mangadex&${qs}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok(), items: body.items || [], total: body.total ?? 0 };
}

(async () => {
  const own = await ensureServer();
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // 1. 登录（弹窗是异步挂载的，必须等它出现再填）
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

    console.log('\n[1] 默认列表不含成人档位');
    const safe = await browse(page, 'limit=50');
    const leak = safe.items.filter(
      (m) => m.contentRating === 'erotica' || m.contentRating === 'pornographic'
    );
    check('默认无成人内容泄漏', safe.ok && safe.items.length > 0 && leak.length === 0,
      `${safe.items.length} 条，泄漏 ${leak.length}`);

    console.log('\n[2] 档位向下累积');
    const ero = await browse(page, 'limit=50&rating=erotica');
    const eroAdult = ero.items.filter((m) => m.contentRating === 'erotica').length;
    const eroPorn = ero.items.filter((m) => m.contentRating === 'pornographic').length;
    check('erotica 档含成人向', ero.ok && eroAdult > 0, `成人向 ${eroAdult} 条`);
    check('erotica 档不含限制级', eroPorn === 0, `限制级 ${eroPorn} 条`);

    // 限制级作品更新慢，按「最新更新」排永远沉在后面，
    // 因此用总量递增来证明确实放开了这一档（contentRating 白名单变大 → total 变大）
    const porn = await browse(page, 'limit=50&rating=pornographic');
    check('放开限制级后总量扩大', porn.ok && porn.total > ero.total && ero.total > safe.total,
      `默认 ${safe.total} → 成人向 ${ero.total} → 限制级 ${porn.total}`);

    // 取样本要换「新作上架」排序并翻几页，否则前 50 条里几乎全是 safe
    let sample = null;
    let samplePage = null;
    for (let p = 1; p <= 4 && !sample; p++) {
      const r = await browse(page, `limit=50&rating=pornographic&sort=newest&page=${p}`);
      const hit = r.items.find((m) => m.contentRating === 'pornographic');
      if (hit) {
        sample = hit;
        samplePage = r;
      }
    }
    check('能取到限制级样本', !!sample, sample ? sample.title.slice(0, 30) : '翻了 4 页仍未取到');

    console.log('\n[3] 放开限制级后硬排除依然生效');
    const batches = [['成人向', ero]];
    if (samplePage) batches.push(['限制级', samplePage]);
    for (const [label, r] of batches) {
      const bad = r.items.filter((m) => (m.tags || []).some((t) => BLOCKED.has(t.name)));
      check(`${label}档无未成年性化题材`, bad.length === 0,
        `${r.items.length} 条，违规 ${bad.length}`);
    }

    console.log('\n[4] 未知档位退回默认');
    const bogus = await browse(page, 'limit=50&rating=bogus');
    const bogusAdult = bogus.items.filter(
      (m) => m.contentRating === 'erotica' || m.contentRating === 'pornographic'
    ).length;
    check('未知档位不放开成人内容', bogus.ok && bogusAdult === 0, `成人 ${bogusAdult} 条`);

    console.log('\n[5] 限制级作品的详情与章节必须带档位');
    const target = sample;
    if (!target) {
      check('取到限制级样本', false, '列表里没有限制级条目');
    } else {
      const withRating = await page.request.get(
        `${BASE}/api/manga/detail?id=${target.id}&source=mangadex&rating=pornographic`
      );
      const body = await withRating.json().catch(() => ({}));
      const chapters = (body.chapters || []).length;
      check('带档位时详情可取且章节非空',
        withRating.ok() && !!body.id && chapters > 0,
        `HTTP ${withRating.status()}，章节 ${chapters}`);

      const noRating = await page.request.get(
        `${BASE}/api/manga/detail?id=${target.id}&source=mangadex`
      );
      const body2 = await noRating.json().catch(() => ({}));
      check('不带档位时取不到该作品（印证必须透传档位）',
        !noRating.ok() || !body2.id || (body2.chapters || []).length === 0,
        `HTTP ${noRating.status()}，章节 ${(body2.chapters || []).length}`);

      console.log('\n[6] 限制级章节的图片链路');
      const first = (body.chapters || [])[0];
      if (!first) {
        check('取到章节用于验证图片', false, '无章节');
      } else {
        const pages = await page.request.get(
          `${BASE}/api/manga/pages?chapter=${encodeURIComponent(first.id)}`
        );
        const pbody = await pages.json().catch(() => ({}));
        check('章节图片接口可用', pages.ok() && (pbody.count || 0) > 0,
          `HTTP ${pages.status()}，${pbody.count || 0} 张`);
      }
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
