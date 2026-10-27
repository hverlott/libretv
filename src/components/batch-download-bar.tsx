'use client';

import { cn } from '@/lib/utils';
import { MAX_BATCH_ITEMS } from './use-batch-download';

/**
 * 批量下载操作条：多选模式下的勾选状态、集数上限与提交按钮。
 * 热门剧集与搜索结果共用同一套交互。
 */
export function BatchDownloadBar({
  selectedCount,
  totalCount,
  submitting,
  episodeLimit,
  onEpisodeLimitChange,
  onSelectAll,
  onClear,
  onSubmit,
}: {
  selectedCount: number;
  totalCount: number;
  submitting: boolean;
  episodeLimit: number | null;
  onEpisodeLimitChange: (v: number | null) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSubmit: () => void;
}) {
  const over = selectedCount > MAX_BATCH_ITEMS;
  return (
    <div className="mb-3 card p-3 flex flex-wrap items-center gap-2">
      <span className="text-sm text-content">已选 {selectedCount} 部</span>
      {over && (
        <span className="text-xs text-warning">
          超出单次上限 {MAX_BATCH_ITEMS} 部，将只下载前 {MAX_BATCH_ITEMS} 部
        </span>
      )}
      <button className="btn-ghost btn-sm" onClick={onSelectAll} disabled={totalCount === 0}>
        全选
      </button>
      <button className="btn-ghost btn-sm" onClick={onClear} disabled={selectedCount === 0}>
        清空
      </button>
      <span className="text-xs text-faint">每部下集数</span>
      <select
        className="bg-chip text-xs text-content rounded px-2 py-1 outline-none"
        value={episodeLimit === null ? 'all' : String(episodeLimit)}
        onChange={(e) =>
          onEpisodeLimitChange(e.target.value === 'all' ? null : Number(e.target.value))
        }
        aria-label="每部影片下载的集数"
      >
        <option value="all">全部</option>
        <option value="1">仅第 1 集</option>
        <option value="3">前 3 集</option>
        <option value="5">前 5 集</option>
        <option value="10">前 10 集</option>
      </select>
      <button
        className={cn('btn-primary btn-sm ml-auto')}
        disabled={selectedCount === 0 || submitting}
        onClick={onSubmit}
        title="在服务器端下载所选影片的全部（或指定集数）"
      >
        {submitting ? '提交中…' : `下载所选 (${Math.min(selectedCount, MAX_BATCH_ITEMS)})`}
      </button>
    </div>
  );
}
