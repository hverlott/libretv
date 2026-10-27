import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

/**
 * 每个用例都要换一个书库目录，而模块级索引缓存是按「根目录 + TTL」判定的，
 * 因此统一 `vi.resetModules()` 重新加载，避免用例之间互相污染。
 */
async function loadModule() {
  vi.resetModules();
  return import('./local-manga');
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-manga-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  delete process.env.LOCAL_MANGA_DIR;
  delete process.env.LOCAL_MANGA_MEMORY_MB;
  delete process.env.LOCAL_MANGA_INDEX_DIR;
});

async function makeImages(dir: string, names: string[]) {
  await fs.mkdir(dir, { recursive: true });
  for (const n of names) await fs.writeFile(path.join(dir, n), Buffer.from('img-' + n));
}

/** 1x1 像素 PNG，用作测试图片 */
const PNG_DATA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function makeZip(file: string, entries: string[]) {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e, Buffer.from('zip-' + e));
  zip.writeZip(file);
}

/* ——————————————— tar 构造（测试用） ——————————————— */

function tarHeader(name: string, size: number, type = '0'): Buffer {
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

function tarPad(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

/** 造一个 tar.gz；`long` 时用 GNU LongLink 写长文件名（真包里常见） */
function tarGzBuffer(entries: { name: string; data: string | Buffer }[], long = false): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    if (long) {
      const nm = Buffer.from(e.name, 'utf8');
      parts.push(tarHeader('././@LongLink', nm.length, 'L'), nm, tarPad(nm.length));
      // 头里的名字按 100 字节截断，真名靠上面的 LongLink 还原
      parts.push(tarHeader(e.name.slice(0, 60), data.length), data, tarPad(data.length));
    } else {
      parts.push(tarHeader(e.name, data.length), data, tarPad(data.length));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

async function makeTarGz(file: string, entries: { name: string; data: string }[], long = false) {
  await fs.writeFile(file, tarGzBuffer(entries, long));
}

async function scan(root: string) {
  process.env.LOCAL_MANGA_DIR = root;
  const m = await loadModule();
  return m;
}

describe('自然排序', () => {
  it('第 2 话排在 第 10 话 前面（纯字典序会反过来）', async () => {
    const { naturalCompare } = await loadModule();
    expect(naturalCompare('第 2 话', '第 10 话')).toBeLessThan(0);
    expect(naturalCompare('第 10 话', '第 2 话')).toBeGreaterThan(0);
  });

  it('数字段优先于文字段，位数不同也按数值比', async () => {
    const { naturalCompare } = await loadModule();
    expect(naturalCompare('001.jpg', '002.jpg')).toBeLessThan(0);
    expect(naturalCompare('2.jpg', '10.jpg')).toBeLessThan(0);
  });
});

describe('书库配置', () => {
  it('未配置 LOCAL_MANGA_DIR 时索引为 null，不报错', async () => {
    delete process.env.LOCAL_MANGA_DIR;
    const m = await loadModule();
    expect(m.getLocalMangaDir()).toBeNull();
    expect(m.isLocalLibraryEnabled()).toBe(false);
    expect(await m.getLocalIndex()).toBeNull();
  });

  it('目录不存在时返回空书库而不是抛错', async () => {
    const m = await scan(path.join(tmpRoot, 'no-such-dir'));
    const index = await m.getLocalIndex({ force: true });
    expect(index?.works ?? []).toEqual([]);
  });
});

describe('扫描目录结构', () => {
  it('子目录是章节，且按自然序排', async () => {
    await makeImages(path.join(tmpRoot, '作品A', '第 1 话'), ['001.jpg', '002.jpg']);
    await makeImages(path.join(tmpRoot, '作品A', '第 2 话'), ['001.jpg']);
    await makeImages(path.join(tmpRoot, '作品A', '第 10 话'), ['001.jpg']);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品A');
    expect(work?.chapters.map((c: { title: string }) => c.title)).toEqual([
      '第 1 话',
      '第 2 话',
      '第 10 话',
    ]);
  });

  it('目录下直接放图 = 单章作品', async () => {
    await makeImages(path.join(tmpRoot, '作品B'), ['001.jpg', '002.jpg', '003.jpg']);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.chapters.length).toBe(1);
    expect(work?.chapters[0].title).toBe('第 1 话');
    expect(work?.chapters[0].pages.length).toBe(3);
  });

  it('cbz 压缩包 = 单章作品，图片按自然序', async () => {
    await makeZip(path.join(tmpRoot, '作品C.cbz'), ['002.jpg', '001.jpg', '010.jpg']);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品C');
    expect(work?.chapters.length).toBe(1);
    expect(
      work?.chapters[0].pages.map((p) => ('steps' in p ? (p.steps.at(-1) ?? null) : null))
    ).toEqual([
      '001.jpg',
      '002.jpg',
      '010.jpg',
    ]);
  });

  it('章节本身可以是压缩包', async () => {
    await makeZip(path.join(tmpRoot, '作品D', '第 1 话.cbz'), ['001.jpg', '002.jpg']);
    await makeZip(path.join(tmpRoot, '作品D', '第 2 话.zip'), ['001.jpg']);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.chapters.map((c: { title: string }) => c.title)).toEqual(['第 1 话', '第 2 话']);
  });

  it('非图片文件与空目录被忽略', async () => {
    await makeImages(path.join(tmpRoot, '作品E'), ['001.jpg']);
    await fs.writeFile(path.join(tmpRoot, '作品E', 'readme.txt'), 'x');
    await fs.mkdir(path.join(tmpRoot, '空目录'), { recursive: true });

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    expect(index?.works.map((w: { title: string }) => w.title)).toEqual(['作品E']);
  });
});

describe('tar / gz 与嵌套压缩包', () => {
  it('tar.gz = 单章作品，能读到图片', async () => {
    await makeTarGz(path.join(tmpRoot, '作品K.tar.gz'), [
      { name: './001.jpg', data: 't-001' },
      { name: './002.jpg', data: 't-002' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品K');
    expect(work?.chapters.length).toBe(1);
    expect(work?.chapters[0].pages.length).toBe(2);

    const page = await m.readLocalPage(work!.chapters[0].id, 1);
    expect(page?.data.toString()).toBe('t-002');
    expect(page?.mime).toBe('image/jpeg');
  });

  it('GNU LongLink 长文件名也能认出扩展名（否则整包扫不出来）', async () => {
    const long = `./作者名/一部名字很长的作品第 1 话/ページ001.jpg`;
    await makeTarGz(
      path.join(tmpRoot, '作品L.tar.gz'),
      [
        { name: long, data: 'long-1' },
        { name: `./作者名/一部名字很长的作品第 1 话/ページ002.jpg`, data: 'long-2' },
      ],
      true
    );

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.chapters[0].pages.length).toBe(2);
    expect(work?.chapters[0].pages[0]).toMatchObject({ kind: 'memory' });

    const page = await m.readLocalPage(work!.chapters[0].id, 0);
    expect(page?.data.toString()).toBe('long-1');
  });

  it('zip 套 tar.gz 的嵌套包能解出来', async () => {
    const inner = tarGzBuffer([
      { name: './001.jpg', data: 'n-001' },
      { name: './002.jpg', data: 'n-002' },
    ]);
    const zip = new AdmZip();
    zip.addFile('本子.tar.gz', inner);
    zip.writeZip(path.join(tmpRoot, '作品M.zip'));

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品M');
    expect(work?.chapters[0].pages.length).toBe(2);

    const page = await m.readLocalPage(work!.chapters[0].id, 0);
    expect(page?.data.toString()).toBe('n-001');
    expect(page?.mime).toBe('image/jpeg');
  });

  it('tar 里图片分属多个目录时按目录拆章', async () => {
    await makeTarGz(path.join(tmpRoot, '作品N.tgz'), [
      { name: './第 1 话/001.jpg', data: 'c1' },
      { name: './第 2 话/001.jpg', data: 'c2' },
      { name: './第 10 话/001.jpg', data: 'c10' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.chapters.map((c: { title: string }) => c.title)).toEqual([
      '第 1 话',
      '第 2 话',
      '第 10 话',
    ]);
    expect(await m.readLocalPage(work!.chapters[2].id, 0)).toMatchObject({ mime: 'image/jpeg' });
  });

  it('根目录散图与子目录混在一起时不拆章，避免冒出怪名字的章节', async () => {
    await makeTarGz(path.join(tmpRoot, '作品O.tar.gz'), [
      { name: './001.jpg', data: 'a' },
      { name: './第 1 话/001.jpg', data: 'b' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    expect(index?.works[0].chapters.length).toBe(1);
  });
});

describe('没收录的条目要给出原因', () => {
  it('不支持的格式会列进 skipped，而不是默默消失', async () => {
    await fs.writeFile(path.join(tmpRoot, '作品P.rar'), 'x');
    const m = await scan(tmpRoot);
    await m.getLocalIndex({ force: true });

    const skipped = m.getLocalSkips();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe('作品P.rar');
    expect(skipped[0].reason).toContain('.rar');
  });

  it('压缩包里没有图片时也会被列出来', async () => {
    await makeZip(path.join(tmpRoot, '作品Q.cbz'), ['readme.txt']);
    const m = await scan(tmpRoot);
    await m.getLocalIndex({ force: true });
    expect(m.getLocalSkips()[0]).toMatchObject({ name: '作品Q.cbz' });
  });
});

describe('流式路径（内存上限压到 0，强制走大包那条路）', () => {
  beforeEach(() => {
    process.env.LOCAL_MANGA_MEMORY_MB = '0';
    process.env.LOCAL_MANGA_INDEX_DIR = path.join(tmpRoot, 'idx');
  });

  it('根目录 tar.gz：流式建索引 + 读页', async () => {
    await makeTarGz(path.join(tmpRoot, '流式A.tar.gz'), [
      { name: './作者甲/作品甲/19/001.webp', data: 's-19-1' },
      { name: './作者甲/作品甲/19/002.webp', data: 's-19-2' },
      { name: './作者甲/作品甲/4/001.webp', data: 's-4-1' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];

    // 多章时作品名取章节目录的公共前缀
    expect(work?.title).toBe('作品甲');
    // 章节按目录拆，且数字感知排序（4 在 19 前）
    expect(work?.chapters.map((c: { title: string }) => c.title)).toEqual(['4', '19']);
    expect(work?.chapters[1].pages.length).toBe(2);

    const page = await m.readLocalPage(work!.chapters[1].id, 1);
    expect(page?.data.toString()).toBe('s-19-2');
    expect(page?.mime).toBe('image/webp');
  });

  it('zip 套 tar.gz：双层嵌套也能流式读出来', async () => {
    const inner = tarGzBuffer([
      { name: './作者乙/作品乙/1/001.png', data: PNG_DATA },
      { name: './作者乙/作品乙/1/002.png', data: PNG_DATA },
    ]);
    const zip = new AdmZip();
    zip.addFile('本子.tar.gz', inner);
    zip.writeZip(path.join(tmpRoot, '流式B.zip'));

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品乙');
    expect(work?.chapters.length).toBe(1);

    const page = await m.readLocalPage(work!.chapters[0].id, 0);
    expect(page?.mime).toBe('image/png');
    expect(page?.data.length).toBeGreaterThan(0);
  });

  it('tar 里的条目顺序不可信：读出来要按文件名重排（实测原包是乱序的）', async () => {
    await makeTarGz(path.join(tmpRoot, '流式C1.tar.gz'), [
      { name: './a/1/00004.webp', data: 'p4' },
      { name: './a/1/00001.webp', data: 'p1' },
      { name: './a/1/00003.webp', data: 'p3' },
      { name: './a/1/00002.webp', data: 'p2' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const ch = index!.works[0].chapters[0];
    expect(ch.pages.length).toBe(4);
    // 顺序必须按 00001→00004，而不是 tar 里的存放顺序
    const names = await Promise.all(
      [0, 1, 2, 3].map(async (i) => (await m.readLocalPage(ch.id, i))?.data.toString())
    );
    expect(names).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('同名条目全部保留，不做任何删除', async () => {
    await makeTarGz(path.join(tmpRoot, '流式C2.tar.gz'), [
      { name: './a/1/001.webp', data: 'dup' },
      { name: './a/1/001.webp', data: 'dup' },
      { name: './a/2/001.webp', data: 'x' },
    ]);

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    expect(index?.works[0].chapters[0].pages.length).toBe(2);
    expect(index?.works[0].chapters[1].pages.length).toBe(1);
  });

  it('索引落盘后复用：第二次扫描不再遍历（页面坐标不变）', async () => {
    const file = path.join(tmpRoot, '流式D.tar.gz');
    await makeTarGz(file, [
      { name: './作者丁/作品丁/1/001.webp', data: 'p1' },
      { name: './作者丁/作品丁/2/001.webp', data: 'p2' },
    ]);
    process.env.LOCAL_MANGA_DIR = tmpRoot;
    const m = await loadModule();
    const first = await m.getLocalIndex({ force: true });
    const firstPages = first!.works[0].chapters.map((c) => c.pages.length);

    // 索引文件应该已经写下来
    const files = await fs.readdir(path.join(tmpRoot, 'idx'));
    expect(files.length).toBeGreaterThan(0);

    const second = await m.getLocalIndex({ force: true });
    expect(second!.works[0].chapters.map((c) => c.pages.length)).toEqual(firstPages);
    expect(second!.works[0].title).toBe(first!.works[0].title);
  });

  it('zip 里直接放图：走中央目录 + 区间流式读', async () => {
    const zip = new AdmZip();
    zip.addFile('作者戊/作品戊/001.png', PNG_DATA);
    zip.addFile('作者戊/作品戊/002.png', PNG_DATA);
    zip.writeZip(path.join(tmpRoot, '流式E.zip'));

    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index?.works[0];
    expect(work?.title).toBe('作品戊');
    expect(work?.chapters[0].pages.length).toBe(2);

    const page = await m.readLocalPage(work!.chapters[0].id, 1);
    expect(page?.mime).toBe('image/png');
  });

  it('超过上限又不是 tar.gz / 图片 zip 的大包：给出明确原因', async () => {
    await makeZip(path.join(tmpRoot, '流式F.zip'), ['readme.txt']);
    const m = await scan(tmpRoot);
    await m.getLocalIndex({ force: true });
    expect(m.getLocalSkips()[0].reason).toContain('流式');
  });
});

describe('id 稳定性与形态', () => {
  it('作品 lm / 章节 lc 前缀，且同一目录重复扫描 id 不变', async () => {
    await makeImages(path.join(tmpRoot, '作品F', '第 1 话'), ['001.jpg']);
    const m = await scan(tmpRoot);

    const first = await m.getLocalIndex({ force: true });
    const id = first?.works[0].id;
    const cid = first?.works[0].chapters[0].id;

    const second = await m.getLocalIndex({ force: true });
    expect(second?.works[0].id).toBe(id);
    expect(second?.works[0].chapters[0].id).toBe(cid);

    expect(m.isLocalWorkId(id as string)).toBe(true);
    expect(m.isLocalChapterId(cid as string)).toBe(true);
    // 在线源的 id 形态不能被误判成本地
    expect(m.isLocalWorkId('391b0423-d847-456f-aff0-8b0cfc03066b')).toBe(false);
    expect(m.isLocalChapterId('12345.678')).toBe(false);
  });
});

describe('读页', () => {
  it('读目录里的图片文件', async () => {
    await makeImages(path.join(tmpRoot, '作品G'), ['001.jpg', '002.png']);
    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const cid = index?.works[0].chapters[0].id as string;

    const page = await m.readLocalPage(cid, 0);
    expect(page?.data.toString()).toBe('img-001.jpg');
    expect(page?.mime).toBe('image/jpeg');

    const second = await m.readLocalPage(cid, 1);
    expect(second?.mime).toBe('image/png');
  });

  it('读压缩包里的图片条目', async () => {
    await makeZip(path.join(tmpRoot, '作品H.cbz'), ['001.jpg', '002.jpg']);
    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const cid = index?.works[0].chapters[0].id as string;

    const page = await m.readLocalPage(cid, 1);
    expect(page?.data.toString()).toBe('zip-002.jpg');
    expect(page?.mime).toBe('image/jpeg');
  });

  it('未知 id 与越界页码返回 null（不接受任意路径）', async () => {
    await makeImages(path.join(tmpRoot, '作品I'), ['001.jpg']);
    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const cid = index?.works[0].chapters[0].id as string;

    expect(await m.readLocalPage('lc0000000000000000', 0)).toBeNull();
    expect(await m.readLocalPage(cid, 99)).toBeNull();
    // 目录穿越式的输入一律不认
    expect(await m.readLocalPage('../../etc/passwd', 0)).toBeNull();
  });
});

describe('对外数据形态', () => {
  it('封面指向图片代理，不暴露本机路径', async () => {
    await makeImages(path.join(tmpRoot, '作品J', '第 1 话'), ['001.jpg']);
    const m = await scan(tmpRoot);
    const index = await m.getLocalIndex({ force: true });
    const work = index!.works[0];

    const summary = m.toWorkSummary(work);
    expect(summary.cover).toContain('/api/manga/image?c=');
    expect(summary.cover).not.toContain(tmpRoot);
    expect(summary.chapterCount).toBe(1);
    expect(summary.pageCount).toBe(1);

    const item = m.toMangaItem(work);
    expect(item.chapters.length).toBe(1);
    expect(item.chapters[0].pages).toBe(1);
  });
});
