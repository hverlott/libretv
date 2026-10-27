/** 漫画功能端到端验证：Playwright + 系统 Edge */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

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

  // 2. 导航有「漫画」入口
  const mangaLink = page.locator('nav a').filter({ hasText: '漫画' }).first();
  check('导航含「漫画」入口', (await mangaLink.count()) > 0);

  // 3. 进漫画页（显式指定 MangaDex：默认源已改为再漫画，这个用例测的是 MangaDex）
  await mangaLink.click();
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/manga?source=mangadex`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('漫画页打开', page.url().includes('/manga'), page.url());

  // 4. 搜索
  const box = page.locator('input[type="search"]').first();
  if (await box.count()) {
    await box.fill('naruto');
    await box.press('Enter');
    await page.waitForTimeout(8000);
    const cards = await page.locator('button.group, .group').count();
    check('搜索出结果', cards > 0, `${cards} 个卡片`);
  } else {
    check('搜索框存在', false);
  }

  // 5. 点第一张卡片 → 详情
  const card = page.locator('button.group').first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(7000);
    const txt = await page.locator('body').innerText();
    check('详情页加载', txt.includes('开始阅读') || txt.includes('章节目录') || txt.includes('简介'), page.url());
  }

  // 6. 开始阅读
  const readBtn = page.locator('button').filter({ hasText: '开始阅读' }).first();
  if (await readBtn.count()) {
    await readBtn.click();
    await page.waitForTimeout(9000);
    const url = page.url();
    check('进入阅读器', url.includes('/manga/read'), url);

    // 图片是否真的渲染出来了
    const imgCount = await page.locator('img').count();
    const firstImg = await page.locator('img').first();
    let naturalW = 0;
    if (await firstImg.count()) {
      naturalW = await firstImg.evaluate((el) => el.naturalWidth).catch(() => 0);
    }
    check('阅读器图片已加载', imgCount > 0 && naturalW > 0, `${imgCount} 张 img，首图 naturalWidth=${naturalW}`);
  } else {
    check('找到「开始阅读」按钮', false);
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})();
