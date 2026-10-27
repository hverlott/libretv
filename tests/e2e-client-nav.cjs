/**
 * 端到端验证：客户端（/app/ 前缀）下的站内导航。
 *
 * 复现的 bug：桌面客户端把 LibreTV 挂在 /app/ 前缀下（面板自己的首页是 /），
 * 而页面里写死的 href="/" 会跳到控制面板首页 —— 表现为「点了主页按钮没反应」。
 *
 * 用真实浏览器（系统 Edge）跑，覆盖：
 * - 播放页「主页」按钮的 href 与点击落地；
 * - header 导航链接是否带 /app 前缀；
 * - 首页搜索跳转是否留在 /app 下。
 */
const { chromium } = require('playwright');

const PANEL = process.env.PANEL_URL || 'http://127.0.0.1:9098';
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  try {
    // 1. 登录
    //    登录弹窗是异步挂载的：必须等它出现再填，不能先 count 再判断
    await page.goto(`${PANEL}/app/`, { waitUntil: 'domcontentloaded' });
    const pw = page.locator('input[type="password"]').first();
    const appeared = await pw
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await pw.fill(PASSWORD);
      await pw.press('Enter');
      // 弹窗消失即代表登录成功
      await pw.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    check('登录完成', appeared && (await page.locator('input[type="password"]').count()) === 0);

    // 2. 取一个真实的点播源 key（客户端里 sourceKey 用的是 env_N 形式）
    const status = await page.evaluate(async () => (await fetch('/api/status')).json());
    const source = status.defaultSources[0];
    check('取到点播源', Boolean(source?.key), source?.key);

    // 3. 播放页：主页按钮
    await page.goto(
      `${PANEL}/app/watch?source=${encodeURIComponent(source.key)}&id=16510&index=0`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.waitForTimeout(5000);

    const bodyText = await page.locator('body').innerText();
    check(
      '播放页已渲染',
      /第\s*\d+\/\d+\s*集/.test(bodyText),
      bodyText.replace(/\s+/g, ' ').slice(0, 50)
    );

    const homeBtn = page.locator('a[aria-label="回首页"]').first();
    const hasHome = (await homeBtn.count()) > 0;
    check('播放页存在主页按钮', hasHome);

    if (hasHome) {
      const href = await homeBtn.getAttribute('href');
      // 关键断言：不能是 '/'（会跳到控制面板）
      check('主页按钮 href 带 /app 前缀', href === '/app', `href=${href}`);

      await homeBtn.click();
      await page.waitForTimeout(3000);

      const afterUrl = page.url();
      check('点击后停在 LibreTV 前缀下', afterUrl.includes('/app') && !afterUrl.includes('/watch'), afterUrl);

      const afterText = await page.locator('body').innerText();
      check('落地是 LibreTV 首页而非控制面板', !afterText.includes('开启服务'));
      check('落地页有搜索框', (await page.locator('input[placeholder*="影片名称"]').count()) > 0);
    }

    // 4. header 导航链接（播放页用自定义 header，站点 Header 组件在首页/直播页）
    await page.goto(`${PANEL}/app/live`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const liveHref = await page
      .locator('nav a[href$="/live"]')
      .first()
      .getAttribute('href')
      .catch(() => null);
    check('header 直播链接带前缀', liveHref === '/app/live', `href=${liveHref}`);

    const logoHref = await page
      .locator('header a[aria-label="LibreTV 首页"]')
      .first()
      .getAttribute('href')
      .catch(() => null);
    check('header Logo 链接带前缀', logoHref === '/app', `href=${logoHref}`);

    // 5. 首页搜索跳转
    await page.goto(`${PANEL}/app/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const box = page.locator('input[placeholder*="影片名称"]').first();
    if (await box.count()) {
      await box.fill('战狼');
      await box.press('Enter');
      await page.waitForTimeout(4000);
      const searchUrl = page.url();
      check('搜索跳转留在 /app 下', searchUrl.includes('/app') && !searchUrl.endsWith('/app/'), searchUrl);
    }

    // 6. 播放页「返回上一级」+ 切集不丢前缀
    //    桌面客户端没有地址栏与后退键，返回键是唯一的出口；
    //    而切集走 router.replace，写死 '/watch' 会把页面带出 /app 前缀，
    //    之后基路径判断失效、首页与返回全部指向控制面板。
    await page.goto(`${PANEL}/app/?s=${encodeURIComponent('肖申克的救赎')}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(8000);

    const backBtn = page.locator('[aria-label="返回上一级"]');
    const cards = page.locator('.card');
    if ((await cards.count()) === 0) {
      check('搜索结果有卡片（用于返回链路验证）', false);
    } else {
      // 多源聚合卡片第一次点击是展开来源列表，再从列表里选一个源才进详情
      await cards.first().locator('[role="button"]').first().click();
      await page.waitForTimeout(1500);
      if ((await page.locator('[role="dialog"]').count()) === 0) {
        const rows = cards.first().locator('[role="button"]');
        if ((await rows.count()) > 1) await rows.nth(1).click();
      }
      const dialogReady = await page
        .locator('[role="dialog"]')
        .waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      check('详情弹窗可打开', dialogReady);

      if (dialogReady) {
        const dialog = page.locator('[role="dialog"]');
        // 弹窗先出现、剧集列表后到：必须等「共 N 集」出现再点，否则点到的是空列表
        const listed = await dialog
          .locator('text=/共\\s*\\d+\\s*集/')
          .first()
          .waitFor({ state: 'visible', timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        check('详情剧集列表已加载', listed);
        const ep = dialog.locator('button').filter({ hasText: /^1$/ }).first();
        if (listed && (await ep.count()) > 0) await ep.click();
        await page.waitForTimeout(5000);

        check('进入播放页', page.url().includes('/watch'), page.url().slice(-40));
        check('播放页有带文字的返回按钮', (await backBtn.count()) > 0);
        check('播放页仍在 /app 前缀下', page.url().includes('/app/watch'));

        // 切集：URL 变了但仍要留在 /app 下（这是之前的真实 bug）
        const nextBtn = page.locator('button', { hasText: '下一集' }).first();
        if ((await nextBtn.count()) > 0 && !(await nextBtn.isDisabled())) {
          await nextBtn.click();
          await page.waitForTimeout(3000);
          check('切集后仍在 /app 前缀下', page.url().includes('/app/watch'), page.url().slice(-40));
        } else {
          console.log('  - 该片只有一集，跳过切集检查');
        }

        // 返回：必须回到搜索结果页，而不是首页或控制面板
        await backBtn.first().click();
        await page.waitForTimeout(3500);
        const backUrl = page.url();
        check(
          '返回后回到搜索结果页',
          backUrl.includes('/app') && backUrl.includes('s=') && !backUrl.includes('/watch'),
          backUrl
        );
        check('返回后不是控制面板', !(await page.locator('body').innerText()).includes('开启服务'));
      }
    }

    check('无页面 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (err) {
    check('执行过程无异常', false, err.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
})();
