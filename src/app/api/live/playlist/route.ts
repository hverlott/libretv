import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { getLiveCache, setLiveCache } from '@/lib/live-cache';
import { parseM3u } from '@/lib/m3u-parser';
import { localPlaylistName } from '@/lib/env-live-sources';
import type { LivePlaylistResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(url: string): string {
  return `live:playlist:${url}`;
}

function extractPlaylistName(content: string): string | undefined {
  const m = content.match(/^#PLAYLIST:(.+)$/m);
  const name = m?.[1]?.trim();
  return name || undefined;
}

/** 反序列化为 M3U 文本（订阅导出用） */
function toM3uText(playlist: LivePlaylistResponse): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const lines = ['#EXTM3U'];
  if (playlist.name) lines.push(`#PLAYLIST:${playlist.name}`);
  for (const c of playlist.channels) {
    const attrs = [
      `tvg-id="${esc(c.tvgId || c.id)}"`,
      c.rawName ? `tvg-name="${esc(c.rawName)}"` : '',
      c.logo ? `tvg-logo="${esc(c.logo)}"` : '',
      `group-title="${esc(c.group || '')}"`,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${c.name}`);
    lines.push(c.url);
  }
  return lines.join('\n');
}

/**
 * 拉取并解析 M3U 直播订阅。
 * GET /api/live/playlist?url=<m3u>&force=1&format=json|m3u
 * - 服务端缓存 10 分钟，force=1 跳过缓存强制刷新；
 * - format=m3u 返回解析后的标准 M3U 文本（订阅导出）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  if (!url) return jsonError('缺少 url 参数', 400);
  const format = sp.get('format') || 'json';
  const force = sp.get('force') === '1';

  // 内置清单（local:xxx.m3u）：直接读 public/ 下的文件。
  // 既不走网络，也不经 SSRF —— 公开 IPTV 仓库在部分网络下不可达，
  // 而本机托管是唯一稳定的方案（见 env-live-sources.ts 的 LOCAL_PLAYLIST_PREFIX）。
  const localName = localPlaylistName(url);
  if (localName) {
    let playlist = force ? undefined : getLiveCache<LivePlaylistResponse>(cacheKey(url));
    if (!playlist) {
      let text: string;
      try {
        const file = await readLocalPlaylist(localName);
        text = file;
      } catch (err) {
        return jsonError(`内置清单读取失败: ${err instanceof Error ? err.message : '未知错误'}`, 404);
      }
      const channels = parseM3u(text);
      const groups = [
        ...new Set(channels.map((c) => c.group).filter((g): g is string => Boolean(g))),
      ].sort((a, b) => a.localeCompare(b, 'zh'));
      playlist = { name: extractPlaylistName(text), channels, groups };
      setLiveCache(cacheKey(url), playlist, CACHE_TTL_MS, text.length);
    }
    return respond(playlist, format);
  }

  // 直播专用校验：默认拒绝内网，部署者可设 LIVE_ALLOW_PRIVATE=1 放行自建 IPTV
  const verdict = await checkLiveUrlAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  // 直播专用缓存：数千频道的播放列表 JSON 不与豆瓣等热点数据共池（通用缓存超限会整体 clear）
  let playlist: LivePlaylistResponse | undefined = force ? undefined : getLiveCache<LivePlaylistResponse>(cacheKey(url));
  if (!playlist) {
    let text: string;
    try {
      // allowPrivate：与直播流代理同一把尺子，LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 订阅才能拉通。
      // 此前漏传该参数，fetchUpstream 的逐跳校验会回落到点播侧 checkUpstreamAllowed，
      // 内网订阅源在第一跳即被判为「目标地址不在允许范围内」，导致直播源无法添加/启用。
      const res = await fetchUpstream(url, { timeoutMs: 15000, retries: 1, allowPrivate: true });
      if (!res.ok) {
        return jsonError(`订阅地址请求失败: ${res.status}`, 502);
      }
      text = await res.text();
    } catch (err) {
      return jsonError(`订阅地址请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }

    const channels = parseM3u(text, url);
    const groups = [...new Set(channels.map((c) => c.group).filter((g): g is string => Boolean(g)))].sort(
      (a, b) => a.localeCompare(b, 'zh')
    );
    playlist = { name: extractPlaylistName(text), channels, groups };
    setLiveCache(cacheKey(url), playlist, CACHE_TTL_MS, text.length);
  }

  return respond(playlist, format);
}

/** 按 format 返回 JSON 或 M3U 文本 */
function respond(playlist: LivePlaylistResponse, format: string): NextResponse {
  if (format === 'm3u') {
    return new NextResponse(toM3uText(playlist), {
      headers: {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  return NextResponse.json(playlist, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * 读取内置直播清单（public/ 下的 .m3u 文件）。
 *
 * 文件名已在 localPlaylistName 里用 `/^[\w.-]+\.m3u$/i` 校验过，
 * 不含 `/` 与 `..`，因此这里拼路径不会穿越到 public 之外。
 */
async function readLocalPlaylist(name: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.join(process.cwd(), 'public', name);
  return fs.readFile(file, 'utf8');
}
