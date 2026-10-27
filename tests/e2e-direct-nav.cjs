/** 直连 8080 场景回归：链接应保持根路径（不带 /app） */
const { chromium } = require('playwright');
// 密码从项目 .env 读（硬编码默认值会在用户改过密码后静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();
(async () => {
  const b = await chromium.launch({ channel:'msedge', args:['--no-sandbox'] });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const results = [];
  const check = (n, ok, d) => { results.push(ok); console.log(`  ${ok?'✓':'✗'} ${n}${d?' — '+d:''}`); };

  await p.goto('http://127.0.0.1:8080/', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(1500);
  const pw = p.locator('input[type="password"]').first();
  if (await pw.waitFor({state:'visible', timeout:8000}).then(()=>true).catch(()=>false)) {
    await pw.fill(PASSWORD); await pw.press('Enter');
    await pw.waitFor({state:'detached', timeout:15000}).catch(()=>{});
    await p.waitForTimeout(1000);
  }
  check('直连登录完成', (await p.locator('input[type="password"]').count()) === 0);

  const logo = await p.locator('header a[aria-label="LibreTV 首页"]').first().getAttribute('href').catch(()=>null);
  check('直连 Logo 链接为根路径', logo === '/', `href=${logo}`);
  const live = await p.locator('nav a[href$="/live"]').first().getAttribute('href').catch(()=>null);
  check('直连直播链接为根路径', live === '/live', `href=${live}`);

  // 播放页主页按钮
  const st = await p.evaluate(async () => (await fetch('/api/status')).json());
  const src = st.defaultSources[0];
  await p.goto(`http://127.0.0.1:8080/watch?source=${encodeURIComponent(src.key)}&id=16510`, { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(4000);
  const home = await p.locator('a[aria-label="回首页"]').first().getAttribute('href').catch(()=>null);
  check('直连播放页主页按钮为根路径', home === '/', `href=${home}`);
  if (home) {
    await p.locator('a[aria-label="回首页"]').first().click();
    await p.waitForTimeout(3000);
    check('直连点击后回到首页', p.url().endsWith('8080/') || p.url() === 'http://127.0.0.1:8080/', p.url());
  }
  await b.close();
  const failed = results.filter(r=>!r).length;
  console.log(`\n结果：${results.length-failed}/${results.length} 项通过`);
  process.exit(failed?1:0);
})();
