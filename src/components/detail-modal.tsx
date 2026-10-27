'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { buildWatchUrl } from '@/lib/utils';
import { formatRemarks } from '@/lib/remarks';
import { SmartImage } from './smart-image';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { cn } from '@/lib/utils';
import { addSearchHistory } from '@/lib/db';
import { copyToClipboard } from '@/lib/clipboard';
import { EmptyState, ErrorState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { Icon } from './icon';
import { detectBasePath } from '@/lib/base-path';
import { RatingLine } from './rating-badge';
import { useRating, fetchRating, type RatingTarget } from './use-ratings';

/**
 * 详情弹窗：剧集列表 + 排序 + 复制链接。
 * 剧集点击 → /watch 路由（URL 携带定位参数，可分享、可后退）。
 *
 * altSources：可选的同片多源列表（热门剧集区块聚合而来）。
 * 提供时顶部显示源切换条，切换后按新源重新拉取剧集。
 */
export function DetailModal({
  item,
  altSources,
  onClose,
}: {
  item: SearchResultItem | null;
  altSources?: SearchResultItem[];
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reversed, setReversed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 多源切换：当前选中的源下标。item 变化（打开另一部剧）时复位。
  const [altIndex, setAltIndex] = useState(0);
  useEffect(() => setAltIndex(0), [item]);

  const hasAlts = (altSources?.length ?? 0) > 1;
  const current: SearchResultItem | null = hasAlts ? altSources![altIndex] ?? null : item;

  // 评分：弹窗打开即拉一条（列表是异步攒批的，这里用户已经明确要看这部，不该再等队列）
  const ratingTarget = current
    ? ({ title: current.name, year: current.year, typeName: current.typeName, adult: current.isAdult } as RatingTarget)
    : undefined;
  const rating = useRating(ratingTarget);
  useEffect(() => {
    if (!ratingTarget || ratingTarget.adult || rating !== undefined) return;
    void fetchRating(ratingTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingTarget?.title, ratingTarget?.year]);

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(Boolean(item), panelRef);

  useEffect(() => setPosterFailed(false), [current?.pic, store.imageProxyMode, store.customImageProxy]);

  // 弹窗打开期间锁定背景滚动
  useEffect(() => {
    if (!item) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [item]);

  useEffect(() => {
    if (!current) {
      setDetail(null);
      setError('');
      return;
    }
    const source = resolveSource(store, current.sourceKey, {
      url: current.sourceUrl,
      name: current.sourceName,
    });
    if (!source) {
      setError('点播源配置不存在（可能已被删除），请在设置中重新添加');
      return;
    }
    setLoading(true);
    setError('');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    api
      .detail(current.vodId, source, controller.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '获取详情失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

  if (!item) return null;
  const info = detail?.videoInfo;
  const episodes = detail ? (reversed ? [...detail.episodes].reverse() : detail.episodes) : [];

  const play = (index: number) => {
    if (!detail || !detail.episodes[index] || !current) return;
    addSearchHistory(current.name).catch(() => {});
    router.push(
      buildWatchUrl({
        sourceKey: current.sourceKey,
        vodId: current.vodId,
        index,
        title: current.name,
        sourceUrl: current.sourceUrl,
        // 客户端（/app/ 前缀）下需带前缀，否则会跳到控制面板自己的路由
        basePath: detectBasePath(pathname),
      })
    );
  };

  const copyLinks = async () => {
    if (!detail || !current) return;
    // 详情接口返回的是同源代理地址（浏览器不直连上游，避免暴露本机 IP）。
    // 复制给别人用需要真实的上游地址，因此这里显式调用 raw 接口取原始链接。
    let links = detail.episodes;
    try {
      const source = resolveSource(store, current.sourceKey, {
        url: current.sourceUrl,
        name: current.sourceName,
      });
      if (source) {
        const raw = await api.rawEpisodes(current.vodId, source);
        if (raw.episodes.length > 0) links = raw.episodes;
      }
    } catch {
      // 取不到原始地址时退回已有内容，不阻断复制
    }
    const ok = await copyToClipboard(links.join('\n'));
    if (ok) toast('播放链接已复制', 'success');
    else toast('复制失败，请检查浏览器权限', 'error');
  };

  // 备注与卡片同源，同样归一化，避免同一部剧在两处显示不同文案
  const remarks = formatRemarks(info?.remarks);
  const metaRows = [
    info?.typeName && ['类型', info.typeName],
    info?.year && ['年份', info.year],
    info?.area && ['地区', info.area],
    info?.director && ['导演', info.director],
    info?.actor && ['主演', info.actor],
    remarks && ['备注', remarks],
  ].filter(Boolean) as [string, string][];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`${item.name} 详情`}
      >
        <div className="flex items-start justify-between gap-4 p-5 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content break-words">{item.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <RatingLine rating={rating} />
              <span className="text-sm text-faint">{current?.sourceName ?? item.sourceName}</span>
            </div>
          </div>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover shrink-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 多源切换：热门剧集是跨源聚合的，允许直接换源看同一集 */}
        {hasAlts && altSources && (
          <div className="px-5 pt-3">
            <div className="text-xs text-faint mb-2">
              {altSources.length} 个源可用，点击切换
            </div>
            <div className="flex flex-wrap gap-1.5">
              {altSources.map((s, i) => (
                <button
                  key={`${s.sourceKey}_${s.vodId}`}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs transition-colors',
                    i === altIndex
                      ? 'bg-accent text-on-accent'
                      : 'bg-chip text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setAltIndex(i)}
                >
                  {s.sourceName}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="p-5 pt-4">
          {loading && <LoadingState label="正在获取剧集信息..." />}

          {!loading && error && <ErrorState message={error || '获取失败'} />}

          {!loading && !error && detail && (
            <>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {current?.pic && !posterFailed && (
                  <SmartImage
                    url={current.pic}
                    mode={store.imageProxyMode}
                    customProxy={store.customImageProxy}
                    alt={current.name}
                    className="w-24 sm:w-32 aspect-[2/3] object-cover rounded-lg bg-chip shrink-0 self-center sm:self-start"
                    loading="eager"
                    onExhausted={() => setPosterFailed(true)}
                  />
                )}
                <div className="min-w-0 space-y-3">
                  {metaRows.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                      {metaRows.map(([k, v]) => (
                        <div key={k} className="truncate" title={`${k}: ${v}`}>
                          <span className="text-faint">{k}:</span>{' '}
                          <span className="text-content">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {info?.desc && (
                    <p className="text-sm text-muted leading-relaxed line-clamp-3">{info.desc}</p>
                  )}
                </div>
              </div>

              {episodes.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => setReversed((v) => !v)}
                        aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                        title="调整剧集列表的排列顺序"
                      >
                        <Icon
                          name="arrowDown"
                          className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                        />
                        {reversed ? '正序排列' : '倒序排列'}
                      </button>
                      <span className="text-sm text-faint">共 {episodes.length} 集</span>
                    </div>
                    <button className="btn-primary btn-sm" onClick={copyLinks}>
                      复制链接
                    </button>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2 max-h-[40vh] overflow-y-auto scrollbar-thin pr-1">
                    {episodes.map((_, i) => {
                      const realIndex = reversed ? detail.episodes.length - 1 - i : i;
                      return (
                        <button
                          key={realIndex}
                          className="btn-ghost btn-sm !px-1 text-center"
                          onClick={() => play(realIndex)}
                        >
                          {realIndex + 1}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon="alert"
                  title="未找到播放资源"
                  description="该视频可能暂时无法播放，请尝试其他视频"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
