'use client';

import { useCallback, useMemo, useState } from 'react';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource } from '@/lib/store';
import type { ServerDownloadSelection } from '@/lib/types';
import { useToast } from './toast';
import { requestShowServerDownload } from './server-download-center';

/**
 * 一键多选下载（服务端执行）。
 *
 * 为什么走服务端而不是浏览器端：
 * 浏览器端每集都要弹一次「另存为」，多选批量下载会变成弹窗地狱，
 * 且受 Cache Storage 配额限制。服务端直接写磁盘，一次提交即可完成多集。
 *
 * 供热门剧集与搜索结果两处共用。
 */

/** 一部可下载的影片（跨源聚合后的主源条目） */
export interface DownloadableItem {
  /** 唯一标识（用于勾选状态） */
  key: string;
  title: string;
  vodId: string;
  sourceKey: string;
  sourceName: string;
  /** 源接口地址；搜索结果里可能缺失，此时从 store 的源配置里解析 */
  sourceUrl?: string;
}

/** 单次批量提交的最大影片数（与服务端上限一致） */
export const MAX_BATCH_ITEMS = 100;

export function useBatchDownload() {
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  /** 每部下几集；null = 全部 */
  const [episodeLimit, setEpisodeLimit] = useState<number | null>(null);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback((keys: string[]) => {
    setSelected(new Set(keys));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const exit = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  /**
   * 提交批量下载。
   * @param items 已勾选的影片（按 key 过滤后的结果）
   */
  const submit = useCallback(
    async (items: DownloadableItem[]) => {
      if (items.length === 0) return;
      setSubmitting(true);
      try {
        // 超过上限时截断并明确告知：直接发过去会被服务端 400 拒绝，
        // 用户只看到一句报错却不知道自己勾了多少
        const capped = items.slice(0, MAX_BATCH_ITEMS);
        const overflow = items.length - capped.length;
        if (overflow > 0) {
          toast(`一次最多下载 ${MAX_BATCH_ITEMS} 部，已选前 ${MAX_BATCH_ITEMS} 部（忽略 ${overflow} 部）`, 'info');
        }

        // 源配置从 store 解析：搜索结果的条目可能不带 sourceUrl，
        // 只带 sourceKey —— 按 key 找回完整配置（含 detail 根地址）
        const selections: ServerDownloadSelection[] = [];
        let skipped = 0;
        for (const item of capped) {
          const source = resolveSource({ customAPIs, envSources }, item.sourceKey, {
            url: item.sourceUrl,
            name: item.sourceName,
          });
          if (!source?.url) {
            skipped += 1;
            continue;
          }
          selections.push({
            source,
            vodId: item.vodId,
            title: item.title,
            ...(episodeLimit !== null ? { maxEpisodes: episodeLimit } : {}),
          });
        }
        if (selections.length === 0) {
          toast('所选影片的点播源配置不存在，请检查设置中的源', 'error');
          return;
        }
        const result = await api.downloadBatch(
          selections,
          selections.length === 1 ? selections[0].title : `${selections.length} 部影片`
        );
        const failed = result.failures.length;
        toast(
          `已加入下载队列：${result.episodeCount} 集` +
            (failed ? `（${failed} 部没有可用播放地址）` : '') +
            (skipped ? `（${skipped} 部因源配置缺失被跳过）` : '') +
            (result.truncated ? `（超出上限，已截断 ${result.truncated} 集）` : ''),
          failed || skipped ? 'error' : 'success'
        );
        exit();
        // 打开下载中心看进度
        requestShowServerDownload();
      } catch (err) {
        toast(err instanceof Error ? err.message : '批量下载提交失败', 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [customAPIs, envSources, episodeLimit, exit, toast]
  );

  const selectedCount = selected.size;

  /** 多选模式下的操作条（两处复用同一套文案与交互） */
  const toolbar = useMemo(
    () => ({
      selectMode,
      setSelectMode,
      selected,
      selectedCount,
      submitting,
      episodeLimit,
      setEpisodeLimit,
      toggle,
      selectAll,
      clear,
      exit,
      submit,
    }),
    [
      selectMode,
      selected,
      selectedCount,
      submitting,
      episodeLimit,
      toggle,
      selectAll,
      clear,
      exit,
      submit,
    ]
  );

  return toolbar;
}
