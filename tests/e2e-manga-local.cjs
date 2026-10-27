/**
 * 本地漫画库端到端验证：Playwright + 系统 Edge。
 *
 * 覆盖：目录扫描 → 书单接口 → 详情章节 → 图片代理 → 页面卡片 → 进阅读器。
 * 书库目录由脚本自己造（临时目录），服务由脚本拉起并带上 LOCAL_MANGA_DIR，
 * 跑完关服务、删目录。
 *
 * 用法：node tests/e2e-manga-local.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '8097';
const BASE = `http://127.0.0.1:${PORT}`;
// 密码从项目 .env 读（不再硬编码默认值，否则改了密码就会静默跑空）
const PASSWORD = require('./e2e-env.cjs').requirePassword();

/** 1x1 像素 PNG，用作测试图片 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

let server = null;
let libraryDir = null;

/* ——————————————— tar 构造（与单测同一套做法） ——————————————— */

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h.write('0000000\0', 148, 8, 'utf8');
  h[156] = type.charCodeAt(0);
  h.write('ustar', 257, 5, 'latin1');
  h[263] = 0x30;
  h[264] = 0x30;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function tarPad(size) {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

/** `long` 走 GNU LongLink —— 真实包里长日文路径就是这么存的 */
function tarGzBuffer(entries, long = false) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data);
    if (long) {
      const nm = Buffer.from(e.name, 'utf8');
      parts.push(tarHeader('././@LongLink', nm.length, 'L'), nm, tarPad(nm.length));
      parts.push(tarHeader(e.name.slice(0, 60), data.length), data, tarPad(data.length));
    } else {
      parts.push(tarHeader(e.name, data.length), data, tarPad(data.length));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** 造一个书库：多章作品（目录）+ 单章作品（cbz）+ 嵌套 zip 套 tar.gz + 不支持的格式 */
function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-local-manga-'));
  const workA = path.join(dir, '测试作品A');
  fs.mkdirSync(path.join(workA, '第 1 话'), { recursive: true });
  fs.mkdirSync(path.join(workA, '第 2 话'), { recursive: true });
  fs.writeFileSync(path.join(workA, '第 1 话', '001.png'), PNG);
  fs.writeFileSync(path.join(workA, '第 1 话', '002.png'), PNG);
  fs.writeFileSync(path.join(workA, '第 2 话', '001.png'), PNG);
  fs.writeFileSync(path.join(workA, '第 1 话', 'cover.txt'), '不是图片');

  const AdmZip = require(path.join(ROOT, 'node_modules/adm-zip'));

  // 用一个最小的 zip 当 cbz：只放一张图
  const zip = new AdmZip();
  zip.addFile('001.png', PNG);
  zip.writeZip(path.join(dir, '测试作品B.cbz'));

  // 嵌套包：外层 zip 里只有一个 tar.gz，且 tar 内是长日文路径
  // 结构按真实包来：作者/作品/章节/图，作品名从目录推出来
  const inner = tarGzBuffer(
    [
      { name: './作者丙/测试作品C/第 1 話/001.png', data: PNG },
      { name: './作者丙/测试作品C/第 1 話/002.png', data: PNG },
    ],
    true
  );
  const outer = new AdmZip();
  outer.addFile('本子.tar.gz', inner);
  outer.writeZip(path.join(dir, '测试作品C.zip'));

  // 不支持的格式：应该出现在 skipped 里，而不是默默消失
  fs.writeFileSync(path.join(dir, '测试作品D.rar'), 'fake');

  return dir;
}

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
    console.log(`复用已在运行的服务 ${BASE} — 注意：该服务未必带 LOCAL_MANGA_DIR，用例可能失败`);
    return false;
  }
  console.log('服务未运行，带 LOCAL_MANGA_DIR 拉起中…');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', PORT], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOCAL_MANGA_DIR: libraryDir,
      // 内存上限压到 0：强制走流式路径（大包才走那条，这里故意让它也走），
      // 索引写到书库目录旁边，跑完随目录一起删掉
      LOCAL_MANGA_MEMORY_MB: '0',
      LOCAL_MANGA_INDEX_DIR: path.join(libraryDir, '.idx'),
    },
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

(async () => {
  libraryDir = makeLibrary();
  const own = await ensureServer();
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
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

    // 2. 书单接口
    const libRes = await page.request.get(`${BASE}/api/manga/local`);
    const lib = await libRes.json().catch(() => ({}));
    const works = lib.works || [];
    check('书库已配置', lib.configured === true, `root=${lib.root}`);
    check('扫到 3 部作品', works.length === 3, works.map((w) => w.title).join(' / '));

    const workA = works.find((w) => w.title === '测试作品A');
    const workB = works.find((w) => w.title === '测试作品B');
    const workC = works.find((w) => w.title === '测试作品C');
    check('目录作品识别为 2 章', workA?.chapterCount === 2, `章节 ${workA?.chapterCount}`);
    check('cbz 作品识别为 1 章', workB?.chapterCount === 1, `章节 ${workB?.chapterCount}`);
    check('非图片文件不计数', workA?.pageCount === 3, `页数 ${workA?.pageCount}`);
    check(
      'zip 套 tar.gz 的嵌套包能扫出来',
      workC?.chapterCount === 1 && workC?.pageCount === 2,
      `章节 ${workC?.chapterCount} / 页数 ${workC?.pageCount}`
    );
    check(
      '不支持的格式列进 skipped',
      (lib.skipped || []).some((s) => s.name === '测试作品D.rar' && s.reason.includes('.rar')),
      JSON.stringify(lib.skipped || [])
    );

    // 3. 详情 → 章节
    const detailRes = await page.request.get(`${BASE}/api/manga/detail?id=${workA.id}`);
    const detail = await detailRes.json().catch(() => ({}));
    const chapters = detail.chapters || [];
    check('详情返回章节列表', detailRes.ok() && chapters.length === 2,
      chapters.map((c) => `${c.title}(${c.pages})`).join(' / '));
    check('章节按自然序', chapters[0]?.title === '第 1 话' && chapters[1]?.title === '第 2 话');

    // 4. 图片代理：本地文件与压缩包内条目都要能读出来
    const imgRes = await page.request.get(
      `${BASE}/api/manga/image?c=${encodeURIComponent(chapters[0].id)}&i=0`
    );
    check('本地目录图片可读', imgRes.ok() && /image\/png/.test(imgRes.headers()['content-type'] || ''),
      `${imgRes.status()} ${imgRes.headers()['content-type']}`);

    const zipImg = await page.request.get(
      `${BASE}/api/manga/image?c=${encodeURIComponent(
        (await (await page.request.get(`${BASE}/api/manga/detail?id=${workB.id}`)).json()).chapters[0].id
      )}&i=0`
    );
    check('cbz 内图片可读', zipImg.ok(), `${zipImg.status()}`);

    // 嵌套包里的图：zip → tar.gz → 长名条目，逐层都要取得到
    const nestedDetail = await (
      await page.request.get(`${BASE}/api/manga/detail?id=${workC.id}`)
    ).json();
    const nestedImg = await page.request.get(
      `${BASE}/api/manga/image?c=${encodeURIComponent(nestedDetail.chapters[0].id)}&i=1`
    );
    check(
      '嵌套 tar.gz 内图片可读',
      nestedImg.ok() && /image\/png/.test(nestedImg.headers()['content-type'] || ''),
      `${nestedImg.status()} ${nestedImg.headers()['content-type']}`
    );

    // 5. 越界页码应 404 而不是 500
    const bad = await page.request.get(
      `${BASE}/api/manga/image?c=${encodeURIComponent(chapters[0].id)}&i=99`
    );
    check('越界页码返回 404', bad.status() === 404, `HTTP ${bad.status()}`);

    // 6. 页面：卡片与章节展开
    await page.goto(`${BASE}/manga/local`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const cards = await page.locator('button.group').count();
    check('页面出现 3 张作品卡片', cards === 3, `${cards} 张`);
    check('显示书库目录', (await page.locator('main').innerText()).includes('共 3 部'));
    check(
      '页面提示未收录条目',
      (await page.locator('main').innerText()).includes('测试作品D.rar')
    );

    await page.locator('button.group').first().click();
    await page.waitForTimeout(2500);
    const chapterBtns = page.locator('button').filter({ hasText: /^第 \d 话\d+ 页$/ });
    check('展开后列出章节', (await chapterBtns.count()) >= 2, `${await chapterBtns.count()} 个`);

    // 7. 进阅读器并确认图片真的渲染出来
    await chapterBtns.first().click();
    await page.waitForTimeout(3500);
    check('跳转到阅读器', page.url().includes('/manga/read'), page.url().slice(0, 80));
    const imgs = page.locator('img');
    const loaded = await imgs.evaluateAll((nodes) =>
      nodes.filter((n) => n.complete && n.naturalWidth > 0).length
    );
    check('阅读器图片加载成功', loaded > 0, `${loaded} 张已解码`);
  } finally {
    await browser.close().catch(() => {});
    if (own) stopServer();
    try {
      fs.rmSync(libraryDir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉无所谓 */
    }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('e2e 运行失败：', err);
  stopServer();
  process.exit(1);
});
