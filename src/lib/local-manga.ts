/**
 * 本地漫画库：把本机目录里的漫画（图片文件夹 / 压缩包）变成可阅读的作品。
 *
 * ## 为什么单独做一个库
 *
 * 已接入的两个源（MangaDex、再漫画）都是在线源，内容由上游决定。
 * 本模块走另一条路：**内容完全由使用者自己放进目录**，系统只负责
 * 扫描出作品与章节、提供封面与阅读器，不做任何抓取、不碰任何上游。
 *
 * ## 目录约定
 *
 * ```
 * LOCAL_MANGA_DIR/
 * ├─ 作品A/                     ← 作品（目录）
 * │   ├─ 第 1 话/001.jpg …      ← 章节（子目录）
 * │   └─ 第 2 话/
 * ├─ 作品B/001.jpg …            ← 目录下直接放图 = 单章作品
 * └─ 作品C.cbz                  ← 压缩包 = 单章作品
 * ```
 *
 * 也支持章节本身是压缩包（`作品A/第 1 话.cbz`）。
 *
 * ## 压缩包：两条读取路径
 *
 * 真实书库里常见「`xxx.zip` 里只有一个 `本子.tar.gz`」这种双层嵌套包，
 * 解压后动辄 1–2GB、几万页，整体读进内存会把进程压垮，因此按体积分流：
 *
 * - **内存路径**（≤ `memoryLimit()`）：整体读入，按条目名取页，
 *   支持任意层嵌套，小包走这条，快且简单；
 * - **流式路径**（超过上限）：zip 按中央目录做**区间流式读**（只读目标条目的
 *   压缩字节），tar.gz 用 `inflateRaw → gunzip → tar 边解析边取页`。
 *   gzip 无法随机定位，取一页就要从流起点走到该条目，所以：
 *   ① 索引（条目名/大小/tar 内偏移）落盘复用，重启不重新扫；
 *   ② 页字节进 LRU 缓存，顺序阅读时后续页直接命中；
 *   ③ 全程只有一次流式遍历在跑（互斥），峰值内存约等于缓存上限。
 *
 * tar 内图片分属多个目录时按目录拆章；作品名取章节目录的公共前缀
 * （`作者/作品/19` → 作品 `作品`、章节 `19`），单章时退回文件名。
 *
 * ## 安全
 *
 * - **不接受任何路径参数**：对外只暴露 `lm`/`lc` + 16 位 hash 的 id，
 *   真实路径只存在于服务端内存索引里，因此不存在目录穿越；
 * - 索引落盘只写**条目名/大小/偏移**，不含图片内容；
 * - id 由相对路径的 sha256 派生，重启后保持稳定，刷新页面不会串作品。
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import type { LocalSkip, LocalWorkSummary, MangaChapter, MangaItem } from './types';

/** 图片扩展名 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
/** 认得的压缩包：zip/cbz 走 adm-zip，tar/tgz/gz 自己解 */
const ARCHIVE_EXT = new Set(['.zip', '.cbz', '.tar', '.tgz', '.gz']);
/** 认得出但解不了的格式，用来给前端一个明确说法，而不是默默消失 */
const UNSUPPORTED_EXT = new Set(['.rar', '.7z', '.cbr', '.cb7', '.pdf', '.epub']);
/** 嵌套压缩包的扩展名（用来判断"包里还有个包"） */
const NESTED_ARCHIVE_EXT = /\.(zip|cbz|tar|tgz|gz)$/i;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

const EMPTY = Buffer.alloc(0);

/** 索引缓存有效期：目录内容不会频繁变，5 分钟足够 */
const INDEX_TTL_MS = 5 * 60 * 1000;

/** 内存路径的体积上限，超过就走流式（可用环境变量覆盖，测试用它强制分流） */
const IN_MEMORY_LIMIT_DEFAULT = 96 * 1024 * 1024;
/** 流式路径的页缓存上限 */
const PAGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const PAGE_CACHE_MAX_ITEMS = 20000;
/**
 * 一次遍历里预取的字节数：命中目标页后继续往前收这么多，供顺序阅读直接命中。
 * 不宜过大 —— 收得越多，冷启动（看封面）越慢，内存拷贝也越多。
 */
const PREFETCH_BYTES = 24 * 1024 * 1024;
/** 嵌套解包的最大层数：zip 套 tar.gz 套 zip… 到此为止 */
const MAX_NEST_DEPTH = 3;
/**
 * 单个压缩包最多收录多少页。
 * 不设小上限 —— 宁可在极端包上多占几 MB 索引，也不能截断内容
 * （实测单个包已到 9881 页，放大到 10 万留足余量）。
 */
const MAX_PAGES_PER_ARCHIVE = 100000;
/** gunzip 输出上限，挡住解压炸弹 */
const GUNZIP_MAX_BYTES = 512 * 1024 * 1024;
/** 流式读写的块大小 */
const STREAM_CHUNK = 256 * 1024;

/** 作品 id：`lm` + 16 位十六进制 */
export const LOCAL_WORK_ID_RE = /^lm[0-9a-f]{16}$/;
/** 章节 id：`lc` + 16 位十六进制 */
export const LOCAL_CHAPTER_ID_RE = /^lc[0-9a-f]{16}$/;

/** 一页图片的位置：磁盘文件、内存容器条目，或（大包的）流式读取坐标 */
export type LocalPageRef =
  | { kind: 'file'; path: string }
  /** 内存路径：逐层进入的条目名，最后一步就是图片本身 */
  | { kind: 'memory'; file: string; steps: string[] }
  /** 流式 tar：条目在 tar 流中的偏移与大小 */
  | { kind: 'tarstream'; source: string; dataStart: number; size: number; ext: string }
  /** 流式 zip：中央目录里的条目坐标，按区间读 + inflateRaw */
  | {
      kind: 'zipentry';
      file: string;
      offset: number;
      csize: number;
      method: number;
      size: number;
      ext: string;
    };

export interface LocalChapter {
  id: string;
  title: string;
  pages: LocalPageRef[];
}

export interface LocalWork {
  id: string;
  title: string;
  chapters: LocalChapter[];
  /** 目录 / 文件的修改时间，用于默认排序 */
  updatedAt: number;
}

interface LocalIndex {
  at: number;
  root: string;
  works: LocalWork[];
  /** 扫到但没法收录的条目，回给前端做提示用 */
  skipped: LocalSkip[];
  byWork: Map<string, LocalWork>;
  byChapter: Map<string, { work: LocalWork; chapter: LocalChapter }>;
}

/** 漫画库根目录；未配置或为空时返回 null */
export function getLocalMangaDir(): string | null {
  const raw = (process.env.LOCAL_MANGA_DIR || '').trim();
  if (!raw) return null;
  return path.resolve(raw);
}

export function isLocalWorkId(id: string): boolean {
  return LOCAL_WORK_ID_RE.test(id);
}

export function isLocalChapterId(id: string): boolean {
  return LOCAL_CHAPTER_ID_RE.test(id);
}

/** id 由相对路径派生：稳定、不含路径信息 */
function workId(rel: string): string {
  return 'lm' + createHash('sha256').update('w:' + rel).digest('hex').slice(0, 16);
}

function chapterId(rel: string): string {
  return 'lc' + createHash('sha256').update('c:' + rel).digest('hex').slice(0, 16);
}

/**
 * 数字感知排序：`第 2 话` 要排在 `第 10 话` 前面。
 * 纯字典序会把 10 排在 2 前面，章节列表就乱了。
 */
export function naturalCompare(a: string, b: string): number {
  const tokenize = (s: string): (string | number)[] =>
    s
      .split(/(\d+)/)
      .filter((x) => x.length > 0)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x.toLowerCase()));
  const ta = tokenize(a);
  const tb = tokenize(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x === typeof y) {
      if (x !== y) return String(x) < String(y) ? -1 : 1;
    } else {
      // 数字段排在文字段前面：`1话` 早于 `番外`
      return typeof x === 'number' ? -1 : 1;
    }
  }
  return 0;
}

/* ——————————————— 公共小工具 ——————————————— */

/** 去掉扩展名后的名字；`.tar.gz` 去掉两层 */
function stripExt(name: string): string {
  const ext = path.extname(name);
  let base = ext ? name.slice(0, name.length - ext.length) : name;
  if (/\.(gz|tgz|bz2|xz)$/i.test(ext) && /\.tar$/i.test(base)) {
    base = base.slice(0, -'.tar'.length);
  }
  return base;
}

/** 图片条目所在的目录（压缩包内路径，统一用 `/`；`./` 开头先去掉） */
function entryDir(name: string): string {
  const n = name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const i = n.lastIndexOf('/');
  if (i <= 0) return '';
  return n.slice(0, i);
}

/** 路径最后一段 */
function lastSegment(p: string): string {
  const segs = p.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}

/** 多个目录的公共前缀（按段比较） */
function commonDirPrefix(dirs: string[]): string {
  if (dirs.length === 0) return '';
  const split = dirs.map((d) => d.split('/').filter(Boolean));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = split[0][i];
    if (seg === undefined) break;
    if (!split.every((s) => s[i] === seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/** 章节目录名（`19`、`第 3 话` 这类）——用来判断要不要往上一级找作品名 */
function looksLikeChapterName(seg: string): boolean {
  return /^\d+$/.test(seg) || /^第\s*\d+/.test(seg) || /^vol\.?\s*\d+/i.test(seg);
}

/**
 * 作品名：取章节目录公共前缀的最后一段（`作者/作品/19` → `作品`）。
 * 只有一个章节目录时，最后一段是章节号就退一级（`作者/作品/1` → `作品`），
 * 否则它本身就是作品名（`作者/作品/图` → `作品`）；
 * 前缀太怪或太长时退回文件名 —— 文件名至少是可预期的。
 */
function deriveWorkTitle(names: string[], fallback: string): string {
  const dirs = [...new Set(names.map(entryDir).filter((d) => d !== ''))];
  if (dirs.length === 0) return fallback;
  let prefix = commonDirPrefix(dirs);
  if (dirs.length === 1) {
    const segs = prefix.split('/').filter(Boolean);
    if (segs.length > 0 && looksLikeChapterName(segs[segs.length - 1])) {
      prefix = segs.slice(0, -1).join('/');
    }
  }
  const seg = lastSegment(prefix);
  if (!seg || seg.length > 60) return fallback;
  return seg;
}

/** 按目录把图片分组；返回按自然序排好的 [目录, 条目][] */
function groupByDir<T extends { name: string }>(pages: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const p of pages) {
    const key = entryDir(p.name);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()].sort((a, b) => naturalCompare(a[0], b[0]));
}

/* ——————————————— tar 解析（内存版） ——————————————— */

interface TarEntry {
  name: string;
  size: number;
  /** 数据起点（已跳过 512 字节头） */
  offset: number;
  type: string;
}

function tarString(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  const stop = end >= 0 && end < off + len ? end : off + len;
  return buf.toString('utf8', off, stop);
}

/**
 * tar 的数字字段：正常是八进制字符串，超大会用 base-256（首字节置高位）。
 * 只关心大小，负数与超大值一律按 0 处理 —— 那种条目我们也不会去读。
 */
function tarNumber(buf: Buffer, off: number, len: number): number {
  if (buf[off] === 0x80) {
    let n = 0;
    for (let i = 1; i < len; i++) n = n * 256 + buf[off + i];
    return n;
  }
  if (buf[off] === 0xff) return 0;
  const s = buf.toString('latin1', off, off + len).replace(/\0[\s\S]*$/, '').trim();
  return parseInt(s.replace(/[^0-7]/g, ''), 8) || 0;
}

function isZeroBlock(buf: Buffer, off: number): boolean {
  const end = Math.min(off + 512, buf.length);
  for (let i = off; i < end; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * 极简 tar 解析：足够列目录和按名字取数据。
 *
 * 处理了两种长文件名机制，否则日文/中文长路径会被截断在 100 字节处，
 * 连扩展名都读不到（实际遇到的包就是这种，表现为「明明有图却扫不出来」）：
 * - GNU LongLink（`L`）：真名放在下一个数据块里；
 * - pax（`x`）：数据块里是 `path=…` 之类的记录。
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxName: string | null = null;

  while (off + 512 <= buf.length) {
    if (isZeroBlock(buf, off)) break;

    let name = tarString(buf, off, 100);
    const size = tarNumber(buf, off + 124, 12);
    const type = String.fromCharCode(buf[off + 156] || 0x30);
    const prefix = tarString(buf, off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const dataOff = off + 512;

    if (type === 'L') {
      longName = tarString(buf, dataOff, size);
    } else if (type === 'x' || type === 'X') {
      const rec = buf.toString('utf8', dataOff, dataOff + size);
      const m = /(?:^|\n)path=([^\n]*)\n/.exec(rec);
      if (m) paxName = m[1];
    } else if (type === '5' || type === '2' || type === '1' || type === '6') {
      longName = null;
      paxName = null;
    } else {
      const finalName = paxName || longName || name;
      if (finalName) out.push({ name: finalName, size, offset: dataOff, type });
      longName = null;
      paxName = null;
    }

    off = dataOff + Math.ceil(size / 512) * 512;
  }

  return out;
}

/* ——————————————— tar 流式解析（大包用） ——————————————— */

interface TarHit {
  name: string;
  size: number;
  /** 数据在 tar 流中的偏移 */
  dataStart: number;
}

interface TarPumpHooks {
  /** 每个普通条目（含非图片） */
  onEntry?(e: TarHit): void;
  /** 目标条目的数据增量 */
  onTarget?(chunk: Buffer): void;
  /** 需要顺带缓存的条目（顺序阅读时后续页直接命中） */
  capture?(dataStart: number, size: number): string | null;
  onCapture?(key: string, data: Buffer): void;
  /** 返回 true 就停止遍历（收够预取量时用，不必解压完整个包） */
  stopWhen?(): boolean;
}

interface PendingEntry {
  kind: 'meta' | 'data';
  /** 该条目占用的总块数（含 512 对齐的填充） */
  total: number;
  got: number;
  /** 真实数据长度（不含填充） */
  limit: number;
  target: boolean;
  captureKey: string | null;
  parts: Buffer[];
}

/**
 * tar 流解析器：喂字节进来，逐条吐条目头。
 *
 * 之所以不用一次性 buffer：大包解压后有 1–2GB，必须边收边处理。
 * 状态机只有「解析头」和「收某条目数据」两种，数据跨块时靠 `pending` 续接。
 */
class TarStreamParser {
  private carry: Buffer = EMPTY;
  private longName: string | null = null;
  private paxName: string | null = null;
  /** 下一个待解析块在 tar 流中的偏移 */
  private cursor = 0;
  private pending: PendingEntry | null = null;
  finished = false;

  constructor(
    private want: { dataStart: number; size: number } | null,
    private hooks: TarPumpHooks
  ) {}

  push(chunk: Buffer): void {
    if (this.finished) return;
    this.carry = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.drain();
  }

  end(): void {
    this.finished = true;
    this.carry = EMPTY;
  }

  private take(n: number): Buffer {
    const out = this.carry.subarray(0, n);
    this.carry = this.carry.subarray(n);
    return out;
  }

  private drain(): void {
    for (;;) {
      if (this.finished) return;

      if (this.pending) {
        if (this.carry.length === 0) return;
        const need = this.pending.total - this.pending.got;
        const n = Math.min(need, this.carry.length);
        const part = this.take(n);
        const p = this.pending;
        p.got += n;

        if (p.kind === 'meta') {
          if (p.got <= p.limit) p.parts.push(part);
          if (p.got >= p.total) {
            const full = Buffer.concat(p.parts);
            if (p.target) this.longName = tarString(full, 0, full.length);
            else {
              const m = /(?:^|\n)path=([^\n]*)\n/.exec(full.toString('utf8'));
              if (m) this.paxName = m[1];
            }
            this.pending = null;
          }
          continue;
        }

        // data：前 limit 字节是内容，其余是 512 对齐填充
        const contentTaken = p.got - n;
        const contentLeft = Math.max(0, p.limit - contentTaken);
        const content = contentLeft > 0 ? part.subarray(0, Math.min(contentLeft, part.length)) : EMPTY;
        if (content.length > 0) {
          if (p.target) this.hooks.onTarget?.(content);
          if (p.captureKey) p.parts.push(content);
        }
        if (p.got >= p.total) {
          if (p.captureKey) this.hooks.onCapture?.(p.captureKey, Buffer.concat(p.parts));
          this.pending = null;
        }
        continue;
      }

      if (this.carry.length < 512) return;
      if (isZeroBlock(this.carry, 0)) {
        this.finished = true;
        return;
      }

      // 头要先解析完再消费，否则名字就没了
      const headerName = tarString(this.carry, 0, 100);
      const prefix = tarString(this.carry, 345, 155);
      const size = tarNumber(this.carry, 124, 12);
      const type = String.fromCharCode(this.carry[156] || 0x30);
      const blocks = Math.ceil(size / 512) * 512;
      const dataStart = this.cursor + 512;
      this.take(512);
      this.cursor += 512;

      if (type === 'L' || type === 'K' || type === 'x' || type === 'X' || type === 'g') {
        // 长名 / pax 元数据：先把数据收齐才能继续
        this.pending = {
          kind: 'meta',
          total: blocks,
          got: 0,
          limit: size,
          target: type === 'L' || type === 'x' || type === 'X',
          captureKey: null,
          parts: [],
        };
        continue;
      }

      if (type === '5' || type === '2' || type === '1' || type === '6' || type === '3' || type === '4') {
        this.longName = null;
        this.paxName = null;
        continue;
      }

      const name = this.paxName || this.longName || (prefix ? `${prefix}/${headerName}` : headerName);
      this.longName = null;
      this.paxName = null;
      this.hooks.onEntry?.({ name, size, dataStart });

      if (size === 0) continue;

      const target = !!this.want && this.want.dataStart === dataStart && this.want.size === size;
      const captureKey = target ? null : this.hooks.capture?.(dataStart, size) ?? null;
      this.pending = {
        kind: 'data',
        total: blocks,
        got: 0,
        limit: size,
        target,
        captureKey,
        parts: [],
      };
    }
  }
}

/**
 * 把一条 tar 字节流读完（或读到目标条目即止）。
 * `want` 为 null 时遍历整包，用于建索引。
 */
async function pumpTar(
  stream: Readable,
  want: { dataStart: number; size: number } | null,
  hooks: TarPumpHooks
): Promise<void> {
  const parser = new TarStreamParser(want, hooks);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    stream.on('error', fail);
    stream.on('aborted', finish);
    stream.on('end', () => {
      parser.end();
      finish();
    });
    stream.on('close', finish);
    stream.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      // 目标拿齐 / 预取够了就可以收，不必等整个包解压完
      if (parser.finished || hooks.stopWhen?.()) {
        stream.unpipe();
        stream.destroy();
        finish();
      }
    });
  });
}

/* ——————————————— 流式读取基础设施 ——————————————— */

interface ZipEntryInfo {
  name: string;
  /** 本地头偏移 */
  offset: number;
  /** 压缩后大小 */
  csize: number;
  /** 解压后大小 */
  size: number;
  /** 压缩方法：0=存储 8=deflate */
  method: number;
  isDir: boolean;
}

/** 从中央目录读条目信息（不读文件内容） */
function readZipEntries(file: string): ZipEntryInfo[] | null {
  try {
    return new AdmZip(file)
      .getEntries()
      .map((e) => ({
        name: e.entryName,
        offset: e.header.offset,
        csize: e.header.compressedSize,
        size: e.header.size,
        method: e.header.method,
        isDir: !!e.isDirectory,
      }));
  } catch {
    return null;
  }
}

/** 读本地头算出数据起点（中央目录里的 offset 指向本地头） */
async function zipDataStart(file: string, offset: number): Promise<number | null> {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(30);
      const { bytesRead } = await fh.read(buf, 0, 30, offset);
      if (bytesRead < 30) return null;
      return offset + 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 流式读 zip 里的一个条目（只读该条目的压缩字节） */
async function zipEntryStream(file: string, e: ZipEntryInfo): Promise<Readable | null> {
  const start = await zipDataStart(file, e.offset);
  if (start === null || e.csize <= 0) return null;
  const raw = createReadStream(file, {
    start,
    end: start + e.csize - 1,
    highWaterMark: STREAM_CHUNK,
  });  if (e.method === 0) return raw;
  if (e.method === 8) return raw.pipe(zlib.createInflateRaw({ chunkSize: STREAM_CHUNK }));
  raw.destroy();
  return null;
}

/** 读一个流式源的全部字节（用于单条目读取） */
async function collectStream(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) return null;
      parts.push(buf);
    }
  } catch {
    return null;
  }
  return Buffer.concat(parts);
}

/** tar 字节流的来源：根目录上的 tar/tgz，或 zip 内的 tar.gz */
interface TarSource {
  key: string;
  open(): Promise<Readable | null>;
}

function maybeGunzip(stream: Readable, gzipped: boolean): Readable {
  if (!gzipped) return stream;
  return stream.pipe(zlib.createGunzip({ chunkSize: STREAM_CHUNK }));
}

/** 根目录上的 .tar / .tar.gz / .tgz / .gz */
async function rootTarSource(file: string): Promise<TarSource | null> {
  let head: Buffer;
  try {
    const fh = await fs.open(file, 'r');
    try {
      head = Buffer.alloc(2);
      await fh.read(head, 0, 2, 0);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  return {
    key: `tar:${file}`,
    open: async () => maybeGunzip(createReadStream(file, { highWaterMark: STREAM_CHUNK }), gzipped),
  };
}

/** zip 内的 tar.gz：zip 区间流 → inflateRaw → gunzip → tar */
function zipInnerTarSource(file: string, entry: ZipEntryInfo): TarSource {
  const gzipped = /\.(gz|tgz)$/i.test(entry.name);
  return {
    key: `tar:${file}#${entry.name}`,
    open: async () => {
      const inner = await zipEntryStream(file, entry);
      if (!inner) return null;
      return maybeGunzip(inner, gzipped);
    },
  };
}

/* ——————————————— 页缓存与遍历互斥 ——————————————— */

const pageCache = new Map<string, Buffer>();
let pageCacheBytes = 0;

function cachePage(key: string, data: Buffer): void {
  const old = pageCache.get(key);
  if (old) pageCacheBytes -= old.length;
  pageCache.set(key, data);
  pageCacheBytes += data.length;
  while (
    pageCache.size > PAGE_CACHE_MAX_ITEMS ||
    (pageCacheBytes > PAGE_CACHE_MAX_BYTES && pageCache.size > 1)
  ) {
    const oldest = pageCache.keys().next().value;
    if (oldest === undefined) break;
    const drop = pageCache.get(oldest);
    if (drop) pageCacheBytes -= drop.length;
    pageCache.delete(oldest);
  }
}

/** 同一时刻只允许一次流式遍历，避免并发把内存和 CPU 打满 */
let passChain: Promise<unknown> = Promise.resolve();
function withPass<T>(fn: () => Promise<T>): Promise<T> {
  const run = passChain.then(fn, fn);
  passChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const tarSources = new Map<string, TarSource>();

/** 从流式 tar 里读一页：没命中缓存就跑一次遍历（顺带缓存途经的页） */
async function readTarStreamPage(
  source: TarSource,
  target: { dataStart: number; size: number }
): Promise<Buffer | null> {
  const key = `${source.key}@${target.dataStart}`;
  const hit = pageCache.get(key);
  if (hit) {
    // 命中后移到末尾，维持 LRU
    pageCache.delete(key);
    pageCache.set(key, hit);
    return hit;
  }
  return withPass(async () => {
    const again = pageCache.get(key);
    if (again) return again;

    const stream = await source.open();
    if (!stream) return null;
    const parts: Buffer[] = [];
    // 只预取目标页之后的一小段：顺序阅读能直接命中，又不会把整包都拷一遍
    let prefetched = 0;
    await pumpTar(stream, target, {
      onTarget: (chunk) => parts.push(chunk),
      capture: (dataStart, size) => {
        if (dataStart <= target.dataStart) return null;
        if (prefetched >= PREFETCH_BYTES) return null;
        prefetched += size;
        return `${source.key}@${dataStart}`;
      },
      onCapture: (k, data) => {
        if (k !== key) cachePage(k, data);
      },
      stopWhen: () => prefetched >= PREFETCH_BYTES,
    });
    const data = parts.length ? Buffer.concat(parts) : null;
    if (data && data.length === target.size) cachePage(key, data);
    return data;
  });
}

/* ——————————————— 索引持久化 ——————————————— */

interface PersistedIndex {
  v: 2;
  file: string;
  size: number;
  mtimeMs: number;
  pages: { name: string; size: number; dataStart: number }[];
}

/** 索引结构版本：改动解析/排序逻辑就加一，旧缓存自动失效重扫 */
const INDEX_VERSION = 2 as const;

/** 索引缓存目录（只存条目元信息，不存图片） */
function indexCacheDir(): string {
  const raw = (process.env.LOCAL_MANGA_INDEX_DIR || '').trim();
  return raw ? path.resolve(raw) : path.join(process.cwd(), '.runtime', 'manga-index');
}

function indexPathFor(file: string): string {
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 16);
  return path.join(indexCacheDir(), `${hash}.json`);
}

async function loadPersistedIndex(
  file: string,
  size: number,
  mtimeMs: number
): Promise<PersistedIndex | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPathFor(file), 'utf8')) as PersistedIndex;
    if (parsed.v !== INDEX_VERSION || parsed.file !== file) return null;
    if (parsed.size !== size || parsed.mtimeMs !== mtimeMs) return null;
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function savePersistedIndex(index: PersistedIndex): Promise<void> {
  try {
    await fs.mkdir(indexCacheDir(), { recursive: true });
    await fs.writeFile(indexPathFor(index.file), JSON.stringify(index), 'utf8');
  } catch {
    // 索引缓存写不进去不影响功能，只是下次要重新扫
  }
}

/* ——————————————— 扫描：内存路径 ——————————————— */

/** 目录下的图片（只取当前层，不递归），已按自然序排好 */
async function listImages(dir: string): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
}

function fileRefs(files: string[]): LocalPageRef[] {
  return files.map((p) => ({ kind: 'file' as const, path: p }));
}

interface Container {
  buf: Buffer;
  kind: 'zip' | 'tar';
  zip?: AdmZip;
  tar?: TarEntry[];
}

/** 压缩包只按条目读到内存，从不解压落盘 */
function openContainer(raw: Buffer): Container | null {
  let buf = raw;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: GUNZIP_MAX_BYTES });
    } catch {
      return null;
    }
  }
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    try {
      return { buf, kind: 'zip', zip: new AdmZip(buf) };
    } catch {
      return null;
    }
  }
  const tar = buf.length >= 512 ? parseTar(buf) : [];
  if (tar.length > 0) return { buf, kind: 'tar', tar };
  return null;
}

function containerEntries(c: Container): { name: string; isDir: boolean }[] {
  if (c.kind === 'zip') {
    return c.zip!.getEntries().map((e) => ({ name: e.entryName, isDir: !!e.isDirectory }));
  }
  return c.tar!.map((e) => ({ name: e.name, isDir: e.type === '5' }));
}

function containerRead(c: Container, name: string): Buffer | null {
  if (c.kind === 'zip') {
    try {
      return c.zip!.readFile(name) ?? null;
    } catch {
      return null;
    }
  }
  const hit = c.tar!.find((e) => e.name === name);
  if (!hit) return null;
  return c.buf.subarray(hit.offset, hit.offset + hit.size);
}

interface MemoryPage {
  steps: string[];
  name: string;
}

/** 递归收集压缩包里的图片；遇到嵌套压缩包就继续往下钻 */
async function collectPages(
  raw: Buffer,
  prefix: string[],
  depth: number,
  out: MemoryPage[]
): Promise<void> {
  const c = openContainer(raw);
  if (!c) return;
  for (const e of containerEntries(c)) {
    if (out.length >= MAX_PAGES_PER_ARCHIVE) return;
    if (e.isDir) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      out.push({ steps: [...prefix, e.name], name: e.name });
      continue;
    }
    if (depth < MAX_NEST_DEPTH && NESTED_ARCHIVE_EXT.test(e.name)) {
      const inner = containerRead(c, e.name);
      if (inner && inner.length > 0) {
        await collectPages(inner, [...prefix, e.name], depth + 1, out);
      }
    }
  }
}

async function memoryPages(file: string): Promise<MemoryPage[]> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch {
    return [];
  }
  const out: MemoryPage[] = [];
  await collectPages(raw, [], 0, out);
  // 只排序、不去重：压缩包里有几个条目就是几页，删任何一条都是丢内容
  out.sort((a, b) => naturalCompare(a.steps.join('/'), b.steps.join('/')));
  return out;
}

/** 内存容器里逐层取一页 */
async function readMemoryPage(file: string, steps: string[]): Promise<Buffer | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch {
    return null;
  }
  let cur = raw;
  for (const step of steps) {
    const c = openContainer(cur);
    if (!c) return null;
    const data = containerRead(c, step);
    if (!data) return null;
    cur = data;
  }
  return cur;
}

/* ——————————————— 扫描：流式路径 ——————————————— */

/** 流式 tar 的索引：条目名 + tar 内坐标 */
async function streamTarPages(
  source: TarSource,
  file: string,
  size: number,
  mtimeMs: number
): Promise<{ name: string; size: number; dataStart: number }[] | null> {
  const cached = await loadPersistedIndex(file, size, mtimeMs);
  if (cached) return cached.pages;

  const stream = await source.open();
  if (!stream) return null;
  const pages: { name: string; size: number; dataStart: number }[] = [];
  await pumpTar(stream, null, {
    onEntry: (e) => {
      if (pages.length >= MAX_PAGES_PER_ARCHIVE) return;
      if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) return;
      pages.push({ name: e.name, size: e.size, dataStart: e.dataStart });
    },
  });
  if (pages.length === 0) return null;

  // **必须按文件名重排**：tar 里存的是打包时的文件系统顺序
  // （实测 `00004, 00012, 00038, 00018` 这种乱序），直接按 tar 顺序展示
  // 会让阅读器页序全乱。也不去重 —— 包里几个条目就是几页。
  pages.sort((a, b) => naturalCompare(a.name, b.name));
  await savePersistedIndex({ v: INDEX_VERSION, file, size, mtimeMs, pages });
  return pages;
}

/** zip 里直接放图片（中央目录就是索引，不用遍历） */
async function zipImagePages(file: string): Promise<
  { name: string; size: number; entry: ZipEntryInfo }[] | null
> {
  const entries = readZipEntries(file);
  if (!entries) return null;
  const out: { name: string; size: number; entry: ZipEntryInfo }[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    if (e.csize <= 0) continue;
    out.push({ name: e.name, size: e.size, entry: e });
    if (out.length >= MAX_PAGES_PER_ARCHIVE) break;
  }
  // 中央目录里的顺序同样不可靠，按文件名重排
  out.sort((a, b) => naturalCompare(a.name, b.name));
  return out.length > 0 ? out : null;
}

/* ——————————————— 章节组装 ——————————————— */

interface ChapterGroup {
  key: string;
  title: string;
  pages: LocalPageRef[];
}

/**
 * 把图片条目按目录拆成章节。
 * 只有「图片全在子目录里、且子目录 ≥ 2 个」才拆 —— 根目录散图和子目录
 * 混在一起时拆出来会得到一堆名字很怪的章节。
 */
function buildChapterGroups(
  names: string[],
  makeRef: (index: number) => LocalPageRef,
  fallbackTitle: string
): ChapterGroup[] {
  const groups = groupByDir(names.map((name, i) => ({ name, i })));
  // 合集常有几百章（实测见过 353 章）；上限只为挡住异常包，不能压塌正常内容
  if (groups.length > 1 && groups.length <= 5000 && !groups.some(([k]) => k === '')) {
    return groups.map(([key, items]) => ({
      key,
      title: lastSegment(key) || fallbackTitle,
      pages: items.map((it) => makeRef(it.i)),
    }));
  }
  return [{ key: '', title: fallbackTitle, pages: names.map((_, i) => makeRef(i)) }];
}

/** 单个压缩包 → 作品（标题 + 章节） */
async function buildArchiveWork(
  file: string
): Promise<{ title: string; chapters: LocalChapter[] } | { error: string }> {
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = await fs.stat(file);
    size = st.size;
    mtimeMs = st.mtimeMs || 0;
  } catch {
    return { error: '文件读取失败' };
  }
  const fileName = stripExt(path.basename(file));

  /* ——— 内存路径：小包，任意嵌套 ——— */
  if (size <= memoryLimit()) {
    const pages = await memoryPages(file);
    if (pages.length === 0) return { error: describeEmptyArchive(file, size) };
    const names = pages.map((p) => p.name);
    return {
      title: deriveWorkTitle(names, fileName),
      chapters: buildChapterGroups(names, (i) => ({ kind: 'memory', file, steps: pages[i].steps }), fileName).map(
        (g) => ({ id: chapterId(`${file}#${g.key}`), title: g.title, pages: g.pages })
      ),
    };
  }

  /* ——— 流式路径：大包 ——— */

  // 1) 根目录上的 tar / tar.gz
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tar' || ext === '.tgz' || ext === '.gz') {
    const source = await rootTarSource(file);
    if (!source) return { error: '解压失败（文件可能损坏）' };
    tarSources.set(source.key, source);
    const pages = await streamTarPages(source, file, size, mtimeMs);
    if (!pages) return { error: '压缩包里没有图片（或解压失败）' };
    return tarWork(file, fileName, pages, source.key);
  }

  // 2) zip / cbz
  const entries = readZipEntries(file);
  if (!entries) return { error: '压缩包损坏或不是有效的 zip' };

  const images = entries.filter(
    (e) => !e.isDir && IMAGE_EXT.has(path.extname(e.name).toLowerCase())
  );
  if (images.length > 0) {
    // zip 里直接放图：中央目录即索引，按条目区间流式读
    const list = await zipImagePages(file);
    if (!list) return { error: '压缩包里没有图片' };
    const names = list.map((p) => p.name);
    return {
      title: deriveWorkTitle(names, fileName),
      chapters: buildChapterGroups(
        names,
        (i) => ({
          kind: 'zipentry',
          file,
          offset: list[i].entry.offset,
          csize: list[i].entry.csize,
          method: list[i].entry.method,
          size: list[i].entry.size,
          ext: path.extname(list[i].name).toLowerCase(),
        }),
        fileName
      ).map((g) => ({ id: chapterId(`${file}#${g.key}`), title: g.title, pages: g.pages })),
    };
  }

  // 3) zip 里套 tar.gz（最常见的大包形态）
  const inner = entries.find((e) => !e.isDir && NESTED_ARCHIVE_EXT.test(e.name));
  if (!inner) return { error: describeEmptyArchive(file, size) };
  const source = zipInnerTarSource(file, inner);
  tarSources.set(source.key, source);
  const pages = await streamTarPages(source, file, size, mtimeMs);
  if (!pages) return { error: '压缩包里没有图片（或解压失败）' };
  return tarWork(file, fileName, pages, source.key);
}

function tarWork(
  file: string,
  fileName: string,
  pages: { name: string; size: number; dataStart: number }[],
  sourceKey: string
): { title: string; chapters: LocalChapter[] } {
  const names = pages.map((p) => p.name);
  return {
    title: deriveWorkTitle(names, fileName),
    chapters: buildChapterGroups(
      names,
      (i) => ({
        kind: 'tarstream',
        source: sourceKey,
        dataStart: pages[i].dataStart,
        size: pages[i].size,
        ext: path.extname(pages[i].name).toLowerCase(),
      }),
      fileName
    ).map((g) => ({ id: chapterId(`${file}#${g.key}`), title: g.title, pages: g.pages })),
  };
}

/** 空压缩包的原因说明：大包要给"为什么不走流式"的明确答案 */
function describeEmptyArchive(file: string, size: number): string {
  const ext = path.extname(file).toLowerCase();
  if (size > memoryLimit() && !ARCHIVE_EXT.has(ext)) return `暂不支持的格式（${ext}）`;
  if (size > memoryLimit()) {
    return `压缩包超过 ${Math.round(memoryLimit() / 1048576)}MB 且不是 tar.gz / 图片 zip 结构，暂不支持流式读取`;
  }
  return '压缩包里没有图片';
}

/** 内存路径的体积上限（环境变量可覆盖，测试用它强制走流式） */
export function memoryLimit(): number {
  const raw = (process.env.LOCAL_MANGA_MEMORY_MB || '').trim();
  const mb = raw ? Number(raw) : NaN;
  if (Number.isFinite(mb) && mb >= 0) return Math.round(mb * 1048576);
  return IN_MEMORY_LIMIT_DEFAULT;
}

/** 从一个作品目录里解析出章节列表 */
async function buildChapters(workDir: string): Promise<LocalChapter[]> {
  const chapters: LocalChapter[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(workDir, { withFileTypes: true });
  } catch {
    return chapters;
  }

  // 1. 子目录 → 章节（目录内直接放图）
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = path.join(workDir, e.name);
    const files = await listImages(sub);
    if (files.length > 0) {
      chapters.push({ id: chapterId(sub), title: e.name, pages: fileRefs(files) });
      continue;
    }
    // 子目录里放的是压缩包：每个压缩包算一章（内部多目录时拆成多章）
    let subEntries: Dirent[] = [];
    try {
      subEntries = await fs.readdir(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of subEntries) {
      if (!f.isFile() || !ARCHIVE_EXT.has(path.extname(f.name).toLowerCase())) continue;
      const built = await buildArchiveWork(path.join(sub, f.name));
      if ('error' in built) continue;
      chapters.push(...built.chapters);
    }
  }

  // 2. 当前层的压缩包 → 章节
  for (const e of entries) {
    if (!e.isFile() || !ARCHIVE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const built = await buildArchiveWork(path.join(workDir, e.name));
    if ('error' in built) continue;
    chapters.push(...built.chapters);
  }

  // 3. 都没有才把当前层散图当成单独一章
  //    （有子目录却没识别出来时，混进一个「第 1 话」会让顺序变乱）
  if (chapters.length === 0) {
    const files = await listImages(workDir);
    if (files.length > 0) {
      chapters.push({ id: chapterId(workDir), title: '第 1 话', pages: fileRefs(files) });
    }
  }

  chapters.sort((a, b) => naturalCompare(a.title, b.title));
  return chapters;
}

async function statMtime(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs || 0;
  } catch {
    return 0;
  }
}

async function buildIndex(root: string): Promise<LocalIndex> {
  const works: LocalWork[] = [];
  const skipped: LocalSkip[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // 根目录读不出来就当空书库，不阻断站点其它功能
    entries = [];
  }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    const ext = path.extname(e.name).toLowerCase();

    if (e.isDirectory()) {
      const chapters = await buildChapters(full);
      if (chapters.length === 0) {
        skipped.push({ name: e.name, reason: '目录里没有可识别的图片或压缩包' });
        continue;
      }
      works.push({ id: workId(full), title: e.name, chapters, updatedAt: await statMtime(full) });
    } else if (ARCHIVE_EXT.has(ext)) {
      const built = await buildArchiveWork(full);
      if ('error' in built) {
        skipped.push({ name: e.name, reason: built.error });
        continue;
      }
      works.push({
        id: workId(full),
        title: built.title,
        chapters: built.chapters,
        updatedAt: await statMtime(full),
      });
    } else if (UNSUPPORTED_EXT.has(ext)) {
      skipped.push({ name: e.name, reason: `暂不支持的格式（${ext}）` });
    }
  }

  works.sort((a, b) => naturalCompare(a.title, b.title));

  const byWork = new Map<string, LocalWork>();
  const byChapter = new Map<string, { work: LocalWork; chapter: LocalChapter }>();
  for (const w of works) {
    byWork.set(w.id, w);
    for (const c of w.chapters) byChapter.set(c.id, { work: w, chapter: c });
  }

  return { at: Date.now(), root, works, skipped, byWork, byChapter };
}

let cached: LocalIndex | null = null;

/**
 * 取索引（带缓存）。未配置 `LOCAL_MANGA_DIR` 或目录不可读时返回 null。
 *
 * @param force 为 true 时忽略缓存重新扫描（用户手动点「刷新」时用）
 */
export async function getLocalIndex(opts: { force?: boolean } = {}): Promise<LocalIndex | null> {
  const root = getLocalMangaDir();
  if (!root) return null;
  if (!opts.force && cached && cached.root === root && Date.now() - cached.at < INDEX_TTL_MS) {
    return cached;
  }
  cached = await buildIndex(root);
  return cached;
}

/** 是否配置了漫画库目录 */
export function isLocalLibraryEnabled(): boolean {
  return getLocalMangaDir() !== null;
}

/** 上一次扫描里没被收录的条目及原因 */
export function getLocalSkips(): LocalSkip[] {
  return cached?.skipped ?? [];
}

export function findLocalWork(id: string): LocalWork | null {
  return cached?.byWork.get(id) ?? null;
}

export function findLocalChapter(id: string): { work: LocalWork; chapter: LocalChapter } | null {
  return cached?.byChapter.get(id) ?? null;
}

/**
 * 读某一页的字节。
 *
 * @returns 数据与 mime；id 不存在、页码越界或文件读不出来时返回 null
 */
export async function readLocalPage(
  chapterIdKey: string,
  index: number
): Promise<{ data: Buffer; mime: string } | null> {
  const hit = findLocalChapter(chapterIdKey);
  if (!hit) return null;
  const ref = hit.chapter.pages[index];
  if (!ref) return null;

  if (ref.kind === 'file') {
    try {
      const data = await fs.readFile(ref.path);
      return { data, mime: MIME[path.extname(ref.path).toLowerCase()] || 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  if (ref.kind === 'memory') {
    const data = await readMemoryPage(ref.file, ref.steps);
    if (!data) return null;
    const last = ref.steps[ref.steps.length - 1] ?? '';
    return { data, mime: MIME[path.extname(last).toLowerCase()] || 'application/octet-stream' };
  }

  if (ref.kind === 'tarstream') {
    const source = tarSources.get(ref.source);
    if (!source) return null;
    const data = await readTarStreamPage(source, { dataStart: ref.dataStart, size: ref.size });
    if (!data) return null;
    return { data, mime: MIME[ref.ext] || 'application/octet-stream' };
  }

  // zipentry：按区间读 + inflateRaw
  const stream = await zipEntryStream(ref.file, {
    name: '',
    offset: ref.offset,
    csize: ref.csize,
    size: ref.size,
    method: ref.method,
    isDir: false,
  });
  if (!stream) return null;
  // 允许的最大字节按解压后大小估，防异常包撑爆内存
  const maxBytes = Math.min(Math.max(ref.size * 2, 8 * 1024 * 1024), 64 * 1024 * 1024);
  const data = await collectStream(stream, maxBytes);
  if (!data) return null;
  return { data, mime: MIME[ref.ext] || 'application/octet-stream' };
}

/* ——————————————— 对外数据形态 ——————————————— */

/** 作品列表条目（类型定义在 types.ts，客户端也要用） */
function coverUrl(work: LocalWork): string | null {
  const first = work.chapters[0];
  if (!first || first.pages.length === 0) return null;
  return `/api/manga/image?c=${encodeURIComponent(first.id)}&i=0`;
}

export function toWorkSummary(work: LocalWork): LocalWorkSummary {
  return {
    id: work.id,
    title: work.title,
    chapterCount: work.chapters.length,
    pageCount: work.chapters.reduce((n, c) => n + c.pages.length, 0),
    cover: coverUrl(work),
    updatedAt: work.updatedAt,
  };
}

/** 转成阅读器认的详情结构 */
export function toMangaItem(work: LocalWork): MangaItem & { chapters: MangaChapter[] } {
  return {
    id: work.id,
    title: work.title,
    altTitles: [],
    description: `本地漫画库 · 共 ${work.chapters.length} 章`,
    cover: coverUrl(work),
    status: null,
    year: null,
    tags: [],
    // 本地内容由使用者自己把关，不参与在线源的内容过滤
    contentRating: 'safe' as MangaItem['contentRating'],
    chapterCount: work.chapters.length,
    originalLanguage: null,
    chapters: work.chapters.map((c) => ({
      id: c.id,
      number: null,
      title: c.title,
      language: 'zh',
      pages: c.pages.length,
    })),
  };
}
