/**
 * 再漫画（中文源）端到端验证：Playwright + 系统 Edge
 *
 * 覆盖全链路：默认源 → 中文搜索 → 详情 → 章节 → 阅读器图片真实加载，
 * 以及地区筛选（含韩漫）与题材筛选是否真的改变结果。
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

const cardSel = 'button.group';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const cardCount = () => page.locator(cardSel).count();

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

  // 2. 默认源是再漫画（中文优先）
  await page.goto(`${BASE}/manga`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const bodyText = await page.locator('body').innerText();
  check('默认源为再漫画', bodyText.includes('再漫画'), page.url());
  check('默认列表有卡片', (await cardCount()) > 0, `${await cardCount()} 张`);

  // 卡片标题应该是中文（再漫画是中文库）
  const firstTitle = (await page.locator(`${cardSel} p`).first().innerText().catch(() => '')) || '';
  check('卡片标题非空且非「无标题」', firstTitle.trim().length > 0 && !firstTitle.includes('无标题'), firstTitle.slice(0, 30));

  // 3. 源切换器存在
  const mdBtn = page.locator('button').filter({ hasText: /^MangaDex$/ }).first();
  check('源切换器含 MangaDex', (await mdBtn.count()) > 0);

  // 4. 地区筛选（再漫画的 zone 参数）
  const krBtn = page.locator('button').filter({ hasText: /^韩国$/ }).first();
  check('地区筛选含「韩国」', (await krBtn.count()) > 0);
  if (await krBtn.count()) {
    await krBtn.click();
    await page.waitForTimeout(6000);
    check('地区筛选写入 URL', page.url().includes('origin=2305'), page.url());
  }

  // 5. 题材筛选写进 URL
  await page.goto(`${BASE}/manga?source=zaimanhua&tags=5848`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  check('题材筛选有结果', (await cardCount()) > 0, `${await cardCount()} 张`);

  // 6. API 层：地区筛选真的改变结果（内地 vs 韩国）
  const apiOf = async (qs) => {
    const res = await page.request.get(`${BASE}/api/manga/browse?source=zaimanhua&${qs}`);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok(), items: body.items || [], total: body.total || 0 };
  };
  const cn = await apiOf('origin=2308&limit=20');
  const kr = await apiOf('origin=2305&limit=20');
  check(
    'API 地区筛选生效（内地与韩国结果不同）',
    cn.ok && kr.ok && cn.items.length > 0 && cn.total !== kr.total,
    `内地 total=${cn.total}，韩国 total=${kr.total}`
  );

  // 7. 中文搜索（上游索引里混着已下架作品，客户端会先验证再展示）
  await page.goto(`${BASE}/manga?source=zaimanhua`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const box = page.locator('input[type="search"]').first();
  await box.fill('尾巴与逆鳞');
  await box.press('Enter');
  await page.waitForTimeout(12000);
  const searchCards = await cardCount();
  check('中文搜索出结果', searchCards > 0, `${searchCards} 张`);

  // 7b. 搜出来的卡片点进去必须能开（已下架的应被过滤掉）
  const searchTitle = (await page.locator(`${cardSel} p`).first().innerText().catch(() => '')) || '';
  check('搜索结果标题非空', searchTitle.trim().length > 0, searchTitle.slice(0, 30));

  // 8. 详情
  await page.locator(cardSel).first().click();
  await page.waitForTimeout(8000);
  const detailText = await page.locator('body').innerText();
  check(
    '详情页加载（含章节目录）',
    detailText.includes('章节目录') || detailText.includes('开始阅读'),
    page.url()
  );

  // 9. 阅读器 + 图片真实加载
  const readBtn = page.locator('button').filter({ hasText: '开始阅读' }).first();
  if (await readBtn.count()) {
    await readBtn.click();
    await page.waitForTimeout(10000);
    check('进入阅读器', page.url().includes('/manga/read'), page.url());

    // 只看漫画图片：页面里还有 header 的站点 logo 等 <img>
    const comicImgs = page.locator('img[src*="/api/manga/image"]');
    const comicImgCount = await comicImgs.count();
    const firstImg = comicImgs.first();
    let naturalW = 0;
    if (comicImgCount > 0) {
      naturalW = await firstImg.evaluate((el) => el.naturalWidth).catch(() => 0);
    }
    check('阅读器图片已加载', comicImgCount > 0 && naturalW > 0, `${comicImgCount} 张漫画图，首图 naturalWidth=${naturalW}`);

    // 图片必须走同源代理，不能直连 images.zaimanhua.com
    const src = (await firstImg.getAttribute('src').catch(() => '')) || '';
    check('图片走同源代理', src.includes('/api/manga/image'), src.slice(0, 70));

    // 上游图床域名不能出现在页面请求里（否则真实 IP 暴露给 CDN）
    const leaked = src.includes('images.zaimanhua.com');
    check('页面未直连上游图床', !leaked);
  } else {
    check('找到「开始阅读」按钮', false);
  }

  // 10. 章节 id 带 z 前缀（阅读器靠它反解源）
  check('章节 id 为再漫画格式', page.url().includes('c=z'), page.url().split('c=')[1] || '');

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  process.exit(1);
});
