/**
 * 漫画「分类浏览」端到端验证：Playwright + 系统 Edge。
 *
 * 覆盖点：默认就有列表（不必先搜索）、排序切换、题材标签、语言筛选、
 * 「加载更多」、以及刷新后筛选条件是否保留（URL 参数化是否生效）。
 *
 * 用法：服务需先在 8080 运行，然后 node tests/e2e-manga-browse.cjs
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

/** 当前列表里的卡片数 */
async function cardCount(page) {
  return page.locator('button.group').count();
}

/** 列表里第一张卡片的标题文字 */
async function firstTitle(page) {
  return page
    .locator('button.group p')
    .first()
    .innerText()
    .catch(() => '');
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

  // 2. 直接进漫画页，不搜索也应该有列表
  await page.goto(`${BASE}/manga?source=mangadex`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const initialCards = await cardCount(page);
  check('默认进入就有漫画列表', initialCards > 0, `${initialCards} 张卡片`);

  // 3. 卡片标题有字（热门作品只有罗马音别名，取值逻辑必须能兜住）
  const title = await firstTitle(page);
  check('卡片标题不为空', title.trim().length > 0 && !title.includes('无标题'), title.slice(0, 40));

  // 4. 排序切换：点「最受欢迎」，URL 应带 sort=popular
  const popularBtn = page.locator('button').filter({ hasText: /^最受欢迎$/ }).first();
  if (await popularBtn.count()) {
    await popularBtn.click();
    await page.waitForTimeout(5000);
    check('排序切换写入 URL', page.url().includes('sort=popular'), page.url());
    check('排序后仍有结果', (await cardCount(page)) > 0);
  } else {
    check('找到「最受欢迎」排序按钮', false);
  }

  // 5. 题材标签：点「动作」
  const actionBtn = page.locator('button').filter({ hasText: /^动作$/ }).first();
  if (await actionBtn.count()) {
    await actionBtn.click();
    await page.waitForTimeout(5000);
    check('题材标签写入 URL', page.url().includes('tags='), page.url());
    const n = await cardCount(page);
    check('按题材筛选后有结果', n > 0, `${n} 张卡片`);
  } else {
    check('找到「动作」题材按钮', false);
  }

  // 6. 语言筛选：点「有中文」
  const zhBtn = page.locator('button').filter({ hasText: /^有中文$/ }).first();
  if (await zhBtn.count()) {
    await zhBtn.click();
    await page.waitForTimeout(5000);
    check('语言筛选写入 URL', page.url().includes('lang=zh'), page.url());
  } else {
    check('找到「有中文」筛选按钮', false);
  }

  // 7. 刷新后筛选条件保留（URL 参数化的意义所在）
  const urlBefore = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  check('刷新后筛选条件保留', page.url() === urlBefore && (await cardCount(page)) > 0, page.url());

  // 8. 清除标签后回到无筛选状态
  const clearBtn = page.locator('button').filter({ hasText: '清除全部标签' }).first();
  if (await clearBtn.count()) {
    await clearBtn.click();
    await page.waitForTimeout(5000);
    check('清除标签后 URL 无 tags', !page.url().includes('tags='), page.url());
  }

  // 9. 加载更多
  const moreBtn = page.locator('button').filter({ hasText: '加载更多' }).first();
  if (await moreBtn.count()) {
    const before = await cardCount(page);
    await moreBtn.click();
    await page.waitForTimeout(6000);
    const after = await cardCount(page);
    check('加载更多追加卡片', after > before, `${before} → ${after}`);
  } else {
    check('找到「加载更多」按钮', false);
  }

  // 10. 点卡片进详情，标签可点回列表
  const card = page.locator('button.group').first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(7000);
    const body = await page.locator('body').innerText();
    check('详情页可打开', body.includes('简介') || body.includes('章节目录') || body.includes('开始阅读'), page.url());
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  process.exit(1);
});
