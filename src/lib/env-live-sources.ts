import type { LiveSourceConfig } from './types';

/**
 * 内置直播清单标记。
 *
 * ## 为什么需要
 *
 * `DEFAULT_LIVE_SOURCES` 只接受 http(s) 绝对地址（见下方的格式校验）。
 * 但本部署刻意把直播清单放在 `public/iptv.m3u`——因为上游那些公开 IPTV
 * 仓库（GitHub raw 等）在部分网络下不可达，而本机托管是唯一稳定的选择。
 *
 * 麻烦在于：
 * 1. 不能填 `http://127.0.0.1:8080/iptv.m3u`——SSRF 会拦本机地址（防内网探测）；
 * 2. 也不能填相对路径——直播列表接口要发起服务端 fetch，无基地址无法解析。
 *
 * 因此约定：url 填 `local:iptv.m3u`，由 `/api/live/playlist` 识别这个前缀，
 * 直接读取 `public/` 下的同名文件，**不走网络、不经 SSRF**。
 */
export const LOCAL_PLAYLIST_PREFIX = 'local:';

/** 从 URL 中取出内置清单文件名；不是内置清单则返回 null */
export function localPlaylistName(url: string): string | null {
  if (!url.startsWith(LOCAL_PLAYLIST_PREFIX)) return null;
  const name = url.slice(LOCAL_PLAYLIST_PREFIX.length).trim().replace(/^\/+/, '');
  // 只允许 public 下的简单文件名，杜绝 ../ 穿越
  if (!/^[\w.-]+\.m3u$/i.test(name)) return null;
  return name;
}

/**
 * 部署者通过 DEFAULT_LIVE_SOURCES 环境变量预置的直播源（M3U 订阅）。
 * 格式为 JSON 数组：[{"name":"源名","url":"https://.../list.m3u","epg":"https://.../epg.xml.gz"}]
 * url 也可写 `local:xxx.m3u` 引用 public/ 下的内置清单（见 LOCAL_PLAYLIST_PREFIX）。
 * 解析失败时告警并整体忽略，不影响站点运行。模式与 env-sources.ts 对齐。
 */
export function getEnvLiveSources(): LiveSourceConfig[] {
  const raw = process.env.DEFAULT_LIVE_SOURCES;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    const list: LiveSourceConfig[] = parsed.map((item, i) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`第 ${i + 1} 项不是对象`);
      }
      const { name, url, epg } = item as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error(`第 ${i + 1} 项缺少 name`);
      }
      const urlText = typeof url === 'string' ? url.trim() : '';
      const isLocal = urlText.startsWith(LOCAL_PLAYLIST_PREFIX);
      if (!isLocal && !/^https?:\/\//.test(urlText)) {
        throw new Error(`第 ${i + 1} 项的 url 必须以 http://、https:// 开头，或用 local:引用内置清单`);
      }
      if (isLocal && !localPlaylistName(urlText)) {
        throw new Error(`第 ${i + 1} 项的 local: 引用非法（只允许 public 下的 *.m3u 文件名）`);
      }
      return {
        key: `envlive_${i}`,
        name: name.trim(),
        url: isLocal ? urlText : urlText.replace(/\/+$/, ''),
        epg: typeof epg === 'string' && epg.trim() ? epg.trim() : undefined,
      };
    });
    return list;
  } catch (err) {
    console.warn('[LibreTV] DEFAULT_LIVE_SOURCES 解析失败，已忽略：', err instanceof Error ? err.message : err);
    return [];
  }
}
