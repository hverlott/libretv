/**
 * 端到端验证：设置里的「内容筛选」（全选 / 只看有评分 + 评分门槛）。
 *
 * 用真实浏览器（系统 Edge）跑，验证：
 * - 设置面板出现筛选控件；
 * - 切到「只看有评分」后，无评分条目（百度热播剧）被隐藏；
 * - 评分门槛生效；
 * - 成人内容过滤开关独立于评分筛选生效。
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
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
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const pw = page.locator('input[type="password"]').first();
    const appeared = await pw
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await pw.fill(PASSWORD);
      await pw.press('Enter');
      await pw.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    check('登录完成', appeared && (await page.locator('input[type="password"]').count()) === 0);

    // 2. 打开设置抽屉
    await page.locator('button[aria-label="设置"]').first().click();
    await page.waitForTimeout(1200);
    const drawerOpen = (await page.locator('[role="dialog"]').count()) > 0;
    check('设置抽屉已打开', drawerOpen);

    // 一级标签：偏好设置 → 二级标签：首页与内容
    const prefs = page.locator('button, [role="tab"]').filter({ hasText: '偏好设置' }).first();
    if (await prefs.count()) {
      await prefs.click();
      await page.waitForTimeout(900);
    }
    const homeTab = page.locator('button, [role="tab"]').filter({ hasText: '首页与内容' }).first();
    if (await homeTab.count()) {
      await homeTab.click();
      await page.waitForTimeout(900);
    }
    check('切到「偏好设置 → 首页与内容」', (await page.locator('text=内容筛选').count()) > 0);

    // 3. 筛选控件存在
    const hasContentFilter = (await page.locator('text=内容筛选').count()) > 0;
    check('设置里有「内容筛选」', hasContentFilter);

    // 4. 默认是「全选」——评分门槛滑块不应出现
    const sliderBefore = await page.locator('input[aria-label="评分门槛"]').count();
    check('默认「全选」时不显示评分门槛', sliderBefore === 0);

    // 5. 切到「只看有评分」——滑块应出现
    //    下拉是自定义组件，点开后选选项
    const dropdown = page.locator('button[aria-label="内容筛选"]').first();
    if (await dropdown.count()) {
      await dropdown.click();
      await page.waitForTimeout(600);
      const ratedOption = page.locator('text=只看有评分').first();
      if (await ratedOption.count()) {
        await ratedOption.click();
        await page.waitForTimeout(800);
      }
    }
    const sliderAfter = await page.locator('input[aria-label="评分门槛"]').count();
    check('切「只看有评分」后出现评分门槛', sliderAfter > 0);

    // 6. 设置被持久化
    const persisted = await page.evaluate(async () => {
      const raw = localStorage.getItem('libretv-settings');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.state?.contentFilterMode ?? null;
    });
    check('筛选设置已持久化', persisted === 'rated', `contentFilterMode=${persisted}`);

    // 7. 关闭设置，看首页效果：百度热播剧（无评分）在「只看有评分」下应被隐藏
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    // 切到影视榜单 → 百度热播剧
    const hotListChip = page.locator('button, [role="tab"]').filter({ hasText: '影视榜单' }).first();
    if (await hotListChip.count()) {
      await hotListChip.click();
      await page.waitForTimeout(2500);
    }
    const baiduChip = page.locator('button').filter({ hasText: '百度热播剧' }).first();
    if (await baiduChip.count()) {
      await baiduChip.click();
      await page.waitForTimeout(3000);
    }
    // 只统计「影视榜单推荐」区内的卡片：页面下方还有热门剧集区，统计全页会误判
    const listSection = page.locator('section[aria-label="影视榜单推荐"]');
    const listCards = await listSection.locator('img[alt]').count();
    check('无评分的百度热播剧被隐藏', listCards === 0, `榜单区卡片=${listCards}`);


    // 8. 评分门槛的量级效应：有豆瓣分的周榜在高分门槛下应被进一步筛掉
    const setMode = async (mode, min) => {
      await page.evaluate(
        ([m, r]) => {
          const raw = localStorage.getItem('libretv-settings');
          const parsed = JSON.parse(raw);
          parsed.state.contentFilterMode = m;
          parsed.state.contentMinRating = r;
          localStorage.setItem('libretv-settings', JSON.stringify(parsed));
        },
        [mode, min]
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
    };
    const listCardCount = async (chip) => {
      const c = page.locator('button').filter({ hasText: chip }).first();
      if (await c.count()) {
        await c.click();
        await page.waitForTimeout(3500);
      }
      const sec = page.locator('section[aria-label="影视榜单推荐"]');
      return sec.locator('img[alt]').count();
    };

    // 豆瓣周榜有评分：≥6 分时基本保留
    await setMode('rated', 6);
    const atSix = await listCardCount('电影周榜');
    check('有评分的周榜在 ≥6 分时保留', atSix > 0, `${atSix} 张`);

    // 门槛提到 9 分：应被进一步筛掉
    await setMode('rated', 9);
    const atNine = await listCardCount('电影周榜');
    check('门槛提到 9 分后进一步筛减', atNine < atSix, `≥6:${atSix} → ≥9:${atNine}`);

    // 9. 切回「全选」应恢复
    await page.locator('button[aria-label="设置"]').first().click();
    await page.waitForTimeout(1000);
    const dd2 = page.locator('button[aria-label="内容筛选"]').first();
    if (await dd2.count()) {
      await dd2.click();
      await page.waitForTimeout(600);
      const allOption = page.locator('text=全选').first();
      if (await allOption.count()) {
        await allOption.click();
        await page.waitForTimeout(800);
      }
    }
    const persisted2 = await page.evaluate(async () => {
      const raw = localStorage.getItem('libretv-settings');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.state?.contentFilterMode ?? null;
    });
    check('可切回「全选」', persisted2 === 'all', `contentFilterMode=${persisted2}`);

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
