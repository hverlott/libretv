import Dexie, { type EntityTable } from 'dexie';
import type { SourceConfig } from './types';
// 仅类型引入：store.ts 运行时会引用本模块，反向只取类型不会形成运行时循环
import type { LiveProbeEntry } from './store';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import {
  blindIndex,
  decryptText,
  encryptText,
  isEncrypted,
} from './privacy-crypto';

/**
 * IndexedDB 持久化（替代旧版 localStorage 数据库）：
 * - 观看历史不再冗余存储全集 URL 列表（旧版长剧 × 50 条极易撑爆 5MB 配额），
 *   只存定位信息（sourceKey+vodId+index），进入播放页时按需重新拉详情，
 *   顺带免费获得「剧集更新同步」能力。
 * - v2：直播测活缓存从 localStorage（随 zustand persist 整体重写）迁入独立表，
 *   高频写入不再拖累设置快照的序列化。
 * - v4：观看历史与搜索历史的敏感字段（片名 / 封面 / 搜索词）加密落盘，
 *   搜索历史主键改为盲索引（HMAC），磁盘上不再出现明文片名。
 *
 * 加密说明：
 * - 密钥由服务端派生并经鉴权接口下发，只在内存中持有（见 privacy-crypto.ts）；
 * - 未注入密钥时按明文读写（首次访问、密钥未就绪的短暂窗口），
 *   已存密文则原样保留，注入密钥后自动按密文路径工作；
 * - 存量明文数据在读取时原样返回（透明兼容），下次写入时转为密文。
 */

export interface HistoryEntry {
  /** 主键：`${sourceKey}_${vodId}` */
  id: string;
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  title: string;
  pic?: string;
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  timestamp: number;
}

export interface ProgressEntry {
  key: string; // `${sourceKey}_${vodId}_${episodeIndex}`
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SearchHistoryEntry {
  /**
   * 主键。启用加密后为盲索引（`bidx1:` 前缀的 HMAC），
   * 存量明文记录则直接是搜索词原文。
   */
  text: string;
  timestamp: number;
  /** 加密后的搜索词（启用加密时存在）；展示与筛选都用它解密后的值 */
  value?: string;
}

export interface SegmentMetaEntry {
  /** Cache Storage 中的 key（归一化的分片绝对地址，或同源代理地址） */
  key: string;
  /** 所属剧集：`${source}:${vodId}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  bytes: number;
  /** 预取时记录的真实耗时（毫秒），loader 命中缓存时合成进 hls.js stats 防 ABR 误判 */
  costMs: number;
  lastAccess: number;
}

export type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadTaskEntry {
  id: string;
  /** 播放页 m3u8 地址（直连或代理形式，入队时的原样） */
  url: string;
  title: string;
  /** 输出格式 */
  format: 'TS' | 'MP4';
  status: DownloadStatus;
  finished: number;
  total: number;
  errorNum: number;
  createdAt: number;
  updatedAt: number;
}

export const db = new Dexie('libretv') as Dexie & {
  history: EntityTable<HistoryEntry, 'id'>;
  progress: EntityTable<ProgressEntry, 'key'>;
  searchHistory: EntityTable<SearchHistoryEntry, 'text'>;
  liveProbe: EntityTable<LiveProbeEntry & { url: string }, 'url'>;
  segmentMeta: EntityTable<SegmentMetaEntry, 'key'>;
  downloads: EntityTable<DownloadTaskEntry, 'id'>;
};

db.version(1).stores({
  history: 'id, timestamp',
  progress: 'key, updatedAt',
  searchHistory: 'text, timestamp',
});

// v2 仅新增表；Dexie 会自动继承低版本的表结构
db.version(2).stores({
  liveProbe: 'url',
});

// v3：视频片段缓存元数据（Cache Storage 存字节、这里存 LRU 索引）与离线下载任务
db.version(3).stores({
  segmentMeta: 'key, episodeKey, lastAccess',
  downloads: 'id, createdAt',
});

export const MAX_HISTORY = 100;
export const MAX_SEARCH_HISTORY = 10;

/**
 * 敏感字段加密辅助。
 *
 * 未注入密钥（首次加载 / 密钥请求失败）时原样返回明文，
 * 保证功能不中断；有密钥时加密后返回。
 */
async function sealText(plain: string | undefined): Promise<string | undefined> {
  if (!plain) return plain;
  if (isEncrypted(plain)) return plain;
  return encryptText(plain);
}

/** 解密；无密钥或解密失败时返回原值（明文兼容 / 密文显示为占位） */
async function openText(value: string | undefined): Promise<string | undefined> {
  if (!value) return value;
  if (!isEncrypted(value)) return value;
  return (await decryptText(value)) ?? '（已加密，密钥不可用）';
}

/** 观看历史条目解密（供 UI 读取） */
export async function decryptHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry> {
  const [title, pic] = await Promise.all([
    openText(entry.title),
    openText(entry.pic),
  ]);
  return { ...entry, title: title ?? entry.title, pic };
}

export async function upsertHistory(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
  const id = `${entry.sourceKey}_${entry.vodId}`;
  const existing = await db.history.get(id);
  // 片名与封面 URL 加密落盘（封面路径常含片名，同样是敏感信息）
  const sealedTitle = await sealText(entry.title);
  const sealedPic = await sealText(entry.pic);
  const merged: HistoryEntry = {
    ...existing,
    ...entry,
    id,
    title: sealedTitle ?? entry.title,
    pic: sealedPic,
    playbackPosition: entry.playbackPosition > 10 ? entry.playbackPosition : existing?.playbackPosition ?? 0,
    duration: entry.duration || existing?.duration || 0,
    timestamp: Date.now(),
  };
  await db.history.put(merged);
  // 淘汰最旧记录
  const count = await db.history.count();
  if (count > MAX_HISTORY) {
    const oldest = await db.history.orderBy('timestamp').limit(count - MAX_HISTORY).toArray();
    await db.history.bulkDelete(oldest.map((o) => o.id));
  }
}

export async function updateHistoryProgress(
  sourceKey: string,
  vodId: string,
  position: number,
  duration: number
): Promise<void> {
  const id = `${sourceKey}_${vodId}`;
  const existing = await db.history.get(id);
  if (!existing) return;
  if (Math.abs(existing.playbackPosition - position) < 2 && Math.abs(existing.duration - duration) < 2) return;
  await db.history.update(id, {
    playbackPosition: position,
    duration,
    timestamp: Date.now(),
  });
}

export async function removeHistory(sourceKey: string, vodId: string): Promise<void> {
  await db.history.delete(`${sourceKey}_${vodId}`);
}

export async function clearAllHistory(): Promise<void> {
  // 一并清进度表：否则从历史重新打开时可能取到已清空的旧进度
  await Promise.all([db.history.clear(), db.progress.clear()]);
}

/**
 * 一键清除全部本地痕迹。
 *
 * 覆盖范围（按「能暴露看了什么」的程度排序）：
 * 1. 观看历史 + 播放进度（片名、封面、观看位置）
 * 2. 搜索历史（搜过什么）
 * 3. 下载任务记录（含片名的文件名）
 * 4. 视频分片缓存（Cache Storage 里的实际视频数据）
 * 5. 直播测活缓存（含频道地址）
 * 6. 片段缓存元数据
 *
 * 刻意**不清**设置项（source 配置、主题等）：那些不是观看痕迹，
 * 清掉会让用户重新配置一遍，得不偿失。
 */
export async function clearAllLocalTraces(): Promise<{ cleared: string[] }> {
  const cleared: string[] = [];

  await Promise.all([db.history.clear(), db.progress.clear()]);
  cleared.push('观看历史与播放进度');

  await db.searchHistory.clear();
  cleared.push('搜索历史');

  await db.downloads.clear();
  cleared.push('下载任务记录');

  await db.liveProbe.clear();
  cleared.push('直播测活缓存');

  await db.segmentMeta.clear();
  cleared.push('分片缓存元数据');

  // Cache Storage 里的实际视频分片数据（体积大，且能还原「看过什么」）
  if (typeof caches !== 'undefined') {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('libretv'))
        .map(async (n) => {
          await caches.delete(n);
        })
    );
    if (names.some((n) => n.startsWith('libretv'))) cleared.push('视频分片缓存');
  }

  return { cleared };
}

export function progressKeyOf(sourceKey: string, vodId: string, episodeIndex: number): string {
  return `${sourceKey}_${vodId}_${episodeIndex}`;
}

export async function saveProgress(sourceKey: string, vodId: string, episodeIndex: number, position: number, duration: number): Promise<void> {
  if (!duration || position < 1) return;
  await db.progress.put({
    key: progressKeyOf(sourceKey, vodId, episodeIndex),
    position,
    duration,
    updatedAt: Date.now(),
  });
}

export async function clearProgress(sourceKey: string, vodId: string, episodeIndex: number): Promise<void> {
  await db.progress.delete(progressKeyOf(sourceKey, vodId, episodeIndex));
}

export async function addSearchHistory(text: string): Promise<void> {
  const t = text.trim().slice(0, 50);
  if (!t) return;
  const key = await blindIndex(t);
  const sealed = await sealText(t);
  await db.searchHistory.put({
    text: key,
    timestamp: Date.now(),
    // 密文放在独立字段，避免主键与展示值混用
    ...(sealed && sealed !== t ? { value: sealed } : {}),
  } as SearchHistoryEntry);
  const count = await db.searchHistory.count();
  if (count > MAX_SEARCH_HISTORY) {
    const oldest = await db.searchHistory.orderBy('timestamp').limit(count - MAX_SEARCH_HISTORY).toArray();
    await db.searchHistory.bulkDelete(oldest.map((o) => o.text));
  }
}

export async function removeSearchHistory(text: string): Promise<void> {
  const key = await blindIndex(text);
  // 盲索引主键与存量明文主键都尝试删除，避免旧记录删不掉
  await db.searchHistory.bulkDelete([key, text]);
}

export async function clearSearchHistory(): Promise<void> {
  await db.searchHistory.clear();
}

/** 撤销「清空搜索记录」：按原时间戳回填，保持原有顺序 */
export async function restoreSearchHistory(entries: SearchHistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  // 回填时重新走加密路径：撤销操作不应把明文写回磁盘
  const rows: SearchHistoryEntry[] = [];
  for (const entry of entries) {
    const key = await blindIndex(entry.text);
    const sealed = await sealText(entry.text);
    rows.push({
      text: key,
      timestamp: entry.timestamp,
      ...(sealed && sealed !== entry.text ? { value: sealed } : {}),
    });
  }
  await db.searchHistory.bulkPut(rows);
}

/**
 * 读取搜索历史（解密后返回可直接展示的明文）。
 *
 * 供 UI 使用：主键仍是盲索引/密文，`text` 字段是解密后的可读搜索词。
 */
export async function readSearchHistory(limit = MAX_SEARCH_HISTORY): Promise<SearchHistoryEntry[]> {
  const rows = await db.searchHistory.orderBy('timestamp').reverse().limit(limit).toArray();
  const out: SearchHistoryEntry[] = [];
  for (const row of rows) {
    const raw = (row as SearchHistoryEntry & { value?: string }).value ?? row.text;
    const text = await openText(raw);
    out.push({ text: text ?? row.text, timestamp: row.timestamp });
  }
  return out;
}

// —— 直播测活缓存（TTL 过滤由调用方负责，本层只管存取） ——

export async function loadLiveProbeResults(): Promise<Record<string, LiveProbeEntry>> {
  const rows = await db.liveProbe.toArray();
  const out: Record<string, LiveProbeEntry> = {};
  for (const r of rows) out[r.url] = r;
  return out;
}

export async function saveLiveProbeResults(entries: Record<string, LiveProbeEntry>): Promise<void> {
  const rows = Object.entries(entries).map(([url, e]) => ({ ...e, url }));
  if (rows.length > 0) await db.liveProbe.bulkPut(rows);
}

export async function clearLiveProbeResultsDb(): Promise<void> {
  await db.liveProbe.clear();
}

// —— 配置导入导出（兼容旧版 LibreTV-Settings JSON 结构的导出格式） ——

export async function exportConfig(): Promise<string> {
  // 导出前 flush：把节流缓冲中的最新设置落盘，避免导出的是 800ms 前的旧快照
  flushPendingPersist();
  const history = await db.history.toArray();
  const settings = localStorage.getItem(PERSIST_KEY);

  const data: Record<string, unknown> = {
    viewingHistory: JSON.stringify(history),
  };
  if (settings) data[PERSIST_KEY] = settings;

  return JSON.stringify({
    name: 'LibreTV-Settings',
    time: Date.now().toString(),
    cfgVer: '2.0.0',
    data,
  });
}

export async function importConfig(content: string): Promise<void> {
  const config = JSON.parse(content) as {
    name?: string;
    data?: Record<string, string>;
  };
  if (config.name !== 'LibreTV-Settings') throw new Error('配置文件格式不正确');
  const data = config.data || {};

  if (typeof data[PERSIST_KEY] === 'string') {
    // 关键：先 flush 节流缓冲中的旧状态再写导入配置，否则缓冲会在
    // 之后 flush 时用导入前的旧状态覆盖刚写入的配置（导入静默丢失）
    flushPendingPersist();
    localStorage.setItem(PERSIST_KEY, data[PERSIST_KEY]);
  }

  if (typeof data['viewingHistory'] === 'string') {
    // 兼容旧版历史结构（含全集 URL 列表），只迁移定位信息
    const legacy = JSON.parse(data['viewingHistory']) as Record<string, unknown>[];
    for (const item of legacy.slice(0, MAX_HISTORY)) {
      const sourceKey = String(item.sourceCode || item.sourceName || '');
      const vodId = String(item.vod_id || '');
      const title = String(item.title || '未知视频');
      if (!sourceKey || !vodId) continue;
      const totalEpisodes = Array.isArray(item.episodes) ? item.episodes.length : 0;
      await upsertHistory({
        sourceKey,
        vodId,
        title,
        episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
        totalEpisodes,
        playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      });
    }
  }
}

export type { SourceConfig };
