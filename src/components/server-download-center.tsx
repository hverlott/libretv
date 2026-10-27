'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import type { ServerDownloadTask } from '@/lib/types';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';

/**
 * 服务端下载中心：展示批量下载队列与进度。
 *
 * 与浏览器端「下载管理」的区别：这里的任务在服务端执行，
 * 文件直接落到服务器磁盘（本地部署即本机磁盘），
 * 因此不涉及「另存为」弹窗，也就能真正做到「一键多选」。
 */

const STATUS_LABEL: Record<ServerDownloadTask['status'], string> = {
  queued: '排队中',
  running: '下载中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

/** 打开下载中心的事件（热门剧集批量下载后自动弹出） */
export const SHOW_SERVER_DOWNLOAD_EVENT = 'libretv:show-server-download';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ServerDownloadCenter({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);

  // 队列在下载中持续变化，用较短轮询间隔跟进进度
  const query = useQuery({
    queryKey: ['server-download-queue'],
    queryFn: ({ signal }) => api.downloadQueue(signal),
    enabled: isOpen,
    refetchInterval: (q) => {
      const tasks = q.state.data?.tasks ?? [];
      // 没有运行中的任务就不必频繁轮询
      return tasks.some((t) => t.status === 'running' || t.status === 'queued') ? 1200 : 8000;
    },
  });

  const batches = useMemo(() => query.data?.batches ?? [], [query.data]);
  const tasks = useMemo(() => query.data?.tasks ?? [], [query.data]);
  const stats = useMemo(() => query.data?.batchStats ?? {}, [query.data]);

  const remove = useCallback(
    async (params: { taskId?: string; batchId?: string; action?: 'clear' }) => {
      const key = params.taskId ?? params.batchId ?? 'clear';
      setRemoving(key);
      try {
        await api.downloadRemove(params);
        await queryClient.invalidateQueries({ queryKey: ['server-download-queue'] });
      } catch (err) {
        toast(err instanceof Error ? err.message : '操作失败', 'error');
      } finally {
        setRemoving(null);
      }
    },
    [queryClient, toast]
  );

  // 批次结束后提示一次（避免每次轮询都弹）
  const notifiedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const batch of batches) {
      const s = stats[batch.id];
      if (!s) continue;
      const done = s.completed + s.failed + s.canceled;
      if (done >= s.total && s.total > 0 && !notifiedRef.current.has(batch.id)) {
        notifiedRef.current.add(batch.id);
        const parts = [`完成 ${s.completed} 集`];
        if (s.failed) parts.push(`失败 ${s.failed} 集`);
        toast(`${batch.label}：${parts.join('，')}`, s.failed ? 'error' : 'success');
      }
    }
  }, [batches, stats, toast]);

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载中心" width="max-w-lg">
      <div className="space-y-3">
        {batches.length === 0 ? (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载任务。在热门剧集里勾选影片，点「批量下载」即可开始。
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-faint">
                共 {batches.length} 个批次 · {tasks.length} 集
              </p>
              <button
                className="btn-ghost btn-sm"
                disabled={removing === 'clear'}
                onClick={() => void remove({ action: 'clear' })}
              >
                清除已完成
              </button>
            </div>

            {batches.map((batch) => {
              const s = stats[batch.id];
              const batchTasks = tasks.filter((t) => t.batchId === batch.id);
              const done = s ? s.completed + s.failed + s.canceled : 0;
              const total = s?.total ?? batchTasks.length;
              const percent = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <div key={batch.id} className="card p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-content truncate" title={batch.label}>
                        {batch.label}
                      </p>
                      <p className="text-xs text-faint">
                        {s
                          ? `完成 ${s.completed}/${total}`
                          : `${total} 集`}
                        {s && s.failed > 0 && <span className="text-danger"> · 失败 {s.failed}</span>}
                        {s && s.bytes > 0 && ` · ${formatBytes(s.bytes)}`}
                      </p>
                    </div>
                    <button
                      className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors shrink-0"
                      onClick={() => void remove({ batchId: batch.id })}
                      aria-label="删除批次"
                      title="取消并删除该批次"
                    >
                      <Icon name="close" className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  {/* 只展开未完成的任务：已完成的几百集不必占屏 */}
                  {(() => {
                    const pending = batchTasks.filter(
                      (t) => t.status !== 'completed'
                    );
                    if (pending.length === 0) return null;
                    return (
                      <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-thin">
                        {pending.map((t) => (
                          <div
                            key={t.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-muted">
                              {t.title}
                              {t.totalEpisodes > 1 && ` 第${t.episode}集`}
                            </span>
                            <span className="flex items-center gap-2 shrink-0">
                              <span
                                className={cn(
                                  t.status === 'failed' && 'text-danger',
                                  t.status === 'running' && 'text-accent',
                                  t.status === 'queued' && 'text-faint',
                                  t.status === 'canceled' && 'text-faint'
                                )}
                              >
                                {t.status === 'running' && t.total > 0
                                  ? `${Math.round((t.finished / t.total) * 100)}%`
                                  : STATUS_LABEL[t.status]}
                              </span>
                              {t.error && (
                                <span className="text-danger truncate max-w-32" title={t.error}>
                                  {t.error}
                                </span>
                              )}
                              <button
                                className="p-1 rounded hover:bg-hover text-muted transition-colors"
                                onClick={() => void remove({ taskId: t.id })}
                                aria-label="取消该集下载"
                              >
                                <Icon name="close" className="w-3 h-3" />
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </>
        )}

        <p className="text-xs text-faint">
          下载在服务器端执行，文件直接保存到服务器磁盘，不占用浏览器存储。
        </p>
      </div>
    </Drawer>
  );
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalServerDownloadCenter() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_SERVER_DOWNLOAD_EVENT, onShow);
    return () => window.removeEventListener(SHOW_SERVER_DOWNLOAD_EVENT, onShow);
  }, []);
  return <ServerDownloadCenter isOpen={open} onClose={() => setOpen(false)} />;
}

/** header 等处调用：打开批量下载中心 */
export function requestShowServerDownload(): void {
  window.dispatchEvent(new CustomEvent(SHOW_SERVER_DOWNLOAD_EVENT));
}
