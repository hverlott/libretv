import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_PLAYLIST_PREFIX,
  getEnvLiveSources,
  localPlaylistName,
} from './env-live-sources';

describe('内置直播清单（local:）', () => {
  afterEach(() => {
    delete process.env.DEFAULT_LIVE_SOURCES;
  });

  it('识别 local: 前缀并取出文件名', () => {
    expect(localPlaylistName('local:iptv.m3u')).toBe('iptv.m3u');
    expect(localPlaylistName(`${LOCAL_PLAYLIST_PREFIX}/iptv.m3u`)).toBe('iptv.m3u');
    expect(localPlaylistName('local:a/b.m3u')).toBeNull();
  });

  it('拒绝路径穿越（../ 逃出 public/）', () => {
    expect(localPlaylistName('local:../../.env')).toBeNull();
    expect(localPlaylistName('local:../secrets.m3u')).toBeNull();
    // 形态上就不该通过扩展名白名单
    expect(localPlaylistName('local:iptv.txt')).toBeNull();
    expect(localPlaylistName('local:iptv.m3u.bak')).toBeNull();
  });

  it('http(s) 地址不视为内置清单', () => {
    expect(localPlaylistName('https://example.com/a.m3u')).toBeNull();
    expect(localPlaylistName('http://127.0.0.1:8080/iptv.m3u')).toBeNull();
  });

  it('DEFAULT_LIVE_SOURCES 接受 local: 形式的 url', () => {
    process.env.DEFAULT_LIVE_SOURCES = JSON.stringify([
      { name: '内置', url: 'local:iptv.m3u' },
      { name: '远程', url: 'https://example.com/live.m3u' },
    ]);
    const list = getEnvLiveSources();
    expect(list).toHaveLength(2);
    expect(list[0].url).toBe('local:iptv.m3u');
    // 本地清单不做末尾斜杠裁剪（没有斜杠可裁）
    expect(list[1].url).toBe('https://example.com/live.m3u');
  });

  it('local: 引用非法文件时整体解析失败并告警（返回空数组）', () => {
    process.env.DEFAULT_LIVE_SOURCES = JSON.stringify([
      { name: '非法', url: 'local:../evil.m3u' },
    ]);
    expect(getEnvLiveSources()).toEqual([]);
  });

  it('缺 name 或 url 非法时同样整体忽略', () => {
    process.env.DEFAULT_LIVE_SOURCES = JSON.stringify([{ url: 'local:iptv.m3u' }]);
    expect(getEnvLiveSources()).toEqual([]);
    process.env.DEFAULT_LIVE_SOURCES = JSON.stringify([{ name: 'x', url: 'ftp://a/b' }]);
    expect(getEnvLiveSources()).toEqual([]);
  });
});