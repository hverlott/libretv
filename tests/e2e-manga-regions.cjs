/**
 * 漫画「原作地区（韩漫 / 国漫…）」与「内容分级」端到端验证：Playwright + 系统 Edge。
 *
 * 与 `e2e-manga-browse.cjs` 的区别：那边测的是排序 / 题材 / 语言 / 分页，
 * 这边测的是新加的地区筛选、成人向档位，以及**服务端硬排除**是否真的生效
 * （带 Loli / Shota / Incest 标签的作品一条都不能返回）。
 *
 * 用法：服务需先在 8080 运行，然后 node tests/e2e-manga-regions.cjs
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function cardCount(page) {
  return page.locator('button.group').count();
}

/** 列表里第一张卡片的标题 */
async function firstTitle(page) {
  return page.locator('button.group p').first().innerText().catch(() => '');
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1. 登录
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

  // 2. 地区筛选行存在
  await page.goto(`${BASE}/manga?source=mangadex`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const koBtn = page.locator('button').filter({ hasText: /^韩国漫画$/ }).first();
  check('地区筛选有「韩国漫画」', (await koBtn.count()) > 0);

  // 3. 点韩漫 → URL 带 origin=ko 且有结果
  if (await koBtn.count()) {
    await koBtn.click();
    await page.waitForTimeout(6000);
    check('韩漫筛选写入 URL', page.url().includes('origin=ko'), page.url());
    const n = await cardCount(page);
    check('韩漫有结果', n > 0, `${n} 张卡片`);
    // 韩漫标题多为 ko-ro 罗马音，取不到就会显示「(无标题)」
    const t = await firstTitle(page);
    check('韩漫卡片标题非空', t.trim().length > 0 && !t.includes('无标题'), t.slice(0, 40));

    // 4. 刷新后仍保留地区筛选
    const urlBefore = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    check('刷新后保留地区筛选', page.url() === urlBefore && (await cardCount(page)) > 0);
  }

  // 5. 分级档位（默认「成人内容过滤」关闭，这一行才出现）
  const ratingBtn = page.locator('button').filter({ hasText: /^含成人向$/ }).first();
  check('分级筛选有「含成人向」', (await ratingBtn.count()) > 0);

  // 6. 打开成人向后仍有结果
  if (await ratingBtn.count()) {
    await ratingBtn.click();
    await page.waitForTimeout(6000);
    check('分级筛选写入 URL', page.url().includes('rating=erotica'), page.url());
    check('含成人向后仍有结果', (await cardCount(page)) > 0);
  }

  // 7. API 层硬排除：带违规标签的作品一条都不能出现
  for (const qs of ['limit=100', 'limit=100&rating=erotica', 'limit=100&origin=ko']) {
    const res = await page.request.get(`${BASE}/api/manga/browse?source=mangadex&${qs}`);
    const ok = res.ok();
    const body = await res.json().catch(() => ({}));
    const items = body.items || [];
    const BLOCKED = new Set(['Loli', 'Shota', 'Incest']);
    const bad = items.filter((m) => (m.tags || []).some((t) => BLOCKED.has(t.name)));
    const porn = items.filter((m) => m.contentRating === 'pornographic');
    check(
      `API 排除违规内容 [${qs}]`,
      ok && items.length > 0 && bad.length === 0 && porn.length === 0,
      `${items.length} 条，违规 ${bad.length}，pornographic ${porn.length}`
    );
  }

  // 8. 分级白名单：不带 rating 时不应出现 erotica
  const safeRes = await page.request.get(`${BASE}/api/manga/browse?source=mangadex&limit=100`);
  const safeBody = await safeRes.json().catch(() => ({}));
  const adultLeak = (safeBody.items || []).filter(
    (m) => m.contentRating === 'erotica' || m.contentRating === 'pornographic'
  );
  check('默认列表不含成人向', adultLeak.length === 0, `泄漏 ${adultLeak.length} 条`);

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  process.exit(1);
});
