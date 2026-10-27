'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource } from '@/lib/store';
import { BROWSE_CATEGORY_LABELS, BROWSE_REGION_LABELS } from '@/lib/browse-parser';
import { cn } from '@/lib/utils';
import { useContentFilter } from './use-content-filter';
import type { BrowseCategory, BrowseItem, BrowseRegion, SourceConfig } from '@/lib/types';
import { SmartImage } from './smart-image';
import { BatchDownloadBar } from './batch-download-bar';
import { useBatchDownload, type DownloadableItem } from './use-batch-download';
import { ratingTooltip } from './rating-badge';
import { useInView } from './use-in-view';
import { useRating, useRatingAutoFill, type RatingTarget } from './use-ratings';

/** 分类 tab 顺序（按观影需求从高到低） */
const CATEGORY_ORDER: BrowseCategory[] = [
  'all',
  'movie',
  'tv',
  'anime',
  'variety',
  'short',
  'doc',
  'sports',
  'adult',
];

/** 地区筛选顺序 */
const REGION_ORDER: BrowseRegion[] = ['all', 'cn', 'us', 'uk', 'jp', 'kr', 'tw', 'hk', 'th'];

/**
 * 热门剧集：跨源聚合采集站列表，按热度排序，分类 tab + 地区筛选。
 *
 * 与「豆瓣推荐」的区别：数据全部来自用户自己的点播源，
 * 展示的每一部剧都能直接在已勾选的源里搜到并播放。
 */
export function BrowseSection({ onOpen }: { onOpen: (item: BrowseItem) => void }) {
  const [category, setCategory] = useState<BrowseCategory>('all');
  const [region, setRegion] = useState<BrowseRegion>('all');
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const { filterBrowse } = useContentFilter();

  // —— 多选批量下载 ——
  const batch = useBatchDownload();

  // 只聚合已勾选的源：热门榜应与用户实际能搜到的范围一致
  const selectedSources: SourceConfig[] = selectedKeys
    .map((key) => resolveSource({ customAPIs, envSources }, key))
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.url));

  const query = useQuery({
    queryKey: ['browse', category, region, selectedKeys, yellowFilter],
    queryFn: ({ signal }) =>
      api.browse(selectedSources, category, yellowFilter, { signal, region }),
    enabled: selectedSources.length > 0,
    // 热门榜变化不频繁，5 分钟内复用缓存
    staleTime: 300_000,
  });

  // 服务端已按「成人内容过滤」剔除成人条目；此处再叠加评分门槛筛选
  // （「只看有评分」模式只保留有豆瓣评分且不低于门槛的条目）
  // rawItems 用 useMemo 包一层：`query.data?.list ?? []` 每次渲染都是新数组，
  // 直接进 useMemo 依赖会让 memo 永远失效、每次渲染都重算筛选。
  const rawItems = useMemo(() => query.data?.list ?? [], [query.data]);
  const items = useMemo(() => filterBrowse(rawItems), [rawItems, filterBrowse]);
  const counts = query.data?.categoryCounts;
  const regionCounts = query.data?.regionCounts;
  const failures = query.data?.failures ?? [];

  // 后台深翻页补完数据后自动刷新一次，让用户看到更全的列表。
  // 只在 warming 从 true 变 false 的那一刻触发——否则初次挂载（warming 还是
  // undefined）就会去 refetch，形成循环。
  const warming = query.data?.warming ?? false;
  const prevWarming = useRef<boolean | null>(null);
  const refetch = query.refetch;
  useEffect(() => {
    const was = prevWarming.current;
    prevWarming.current = warming;
    // was === true → warming 变 false：预热结束，刷新一次拿最新数据
    if (was === true && !warming) {
      refetch();
    }
  }, [warming, refetch]);

  // 分类有内容才显示该 tab
  const visibleCategories = CATEGORY_ORDER.filter(
    (c) => c === 'all' || (counts?.[c] ?? 0) > 0
  );

  // 地区有内容才显示该筛选项
  const visibleRegions = REGION_ORDER.filter(
    (r) => r === 'all' || (regionCounts?.[r] ?? 0) > 0
  );

  // —— 多选逻辑 ——
  const itemKey = (item: BrowseItem) => `${item.sourceKey}_${item.vodId}_${item.name}`;

  const selectedItems: DownloadableItem[] = items
    .filter((item) => batch.selected.has(itemKey(item)))
    .map((item) => ({
      key: itemKey(item),
      title: item.name,
      vodId: item.vodId,
      sourceKey: item.sourceKey,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
    }));

  if (selectedSources.length === 0) return null;

  return (
    <section aria-label="热门剧集" className="mt-10">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-sm text-muted">
          热门剧集
          {query.data && (
            <span className="text-faint">
              （来自 {query.data.sourceCount} 个点播源 · {items.length} 部）
            </span>
          )}
        </h2>
        {items.length > 0 && (
          <button
            className={cn('btn-ghost btn-sm', batch.selectMode && 'text-accent')}
            onClick={() => (batch.selectMode ? batch.exit() : batch.setSelectMode(true))}
            title="勾选多部影片，一次性加入下载队列"
          >
            {batch.selectMode ? '退出多选' : '批量下载'}
          </button>
        )}
      </div>

      {/* 多选操作条：只在多选模式出现 */}
      {batch.selectMode && (
        <BatchDownloadBar
          selectedCount={batch.selectedCount}
          totalCount={items.length}
          submitting={batch.submitting}
          episodeLimit={batch.episodeLimit}
          onEpisodeLimitChange={batch.setEpisodeLimit}
          onSelectAll={() => batch.selectAll(items.map(itemKey))}
          onClear={batch.clear}
          onSubmit={() => void batch.submit(selectedItems)}
        />
      )}

      {visibleCategories.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {visibleCategories.map((c) => (
            <button
              key={c}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                c === category
                  ? 'bg-accent text-on-accent'
                  : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => setCategory(c)}
            >
              {BROWSE_CATEGORY_LABELS[c]}
              {counts && counts[c] > 0 && (
                <span className="opacity-70 ml-1">{counts[c]}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 地区筛选：源站没有「地区」这个分类维度，海外剧混在剧集里，
          这里按二级分类名 + area 归并出来，方便直接找欧美/日韩内容 */}
      {visibleRegions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-xs text-faint mr-0.5">地区</span>
          {visibleRegions.map((r) => (
            <button
              key={r}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                r === region
                  ? 'bg-accent text-on-accent'
                  : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => setRegion(r)}
            >
              {BROWSE_REGION_LABELS[r]}
              {regionCounts && regionCounts[r] > 0 && (
                <span className="opacity-70 ml-1">{regionCounts[r]}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {failures.length > 0 && (
        <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 text-faint">
          {failures.length} 个源本次未响应，其余源的结果照常展示
        </div>
      )}

      {query.data?.warming && (
        <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 text-faint flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          正在持续补充更深的内容，热门剧集会越来越全
        </div>
      )}

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">热门剧集加载失败，可稍后重试</p>
      ) : query.isLoading ? (
        <BrowseSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">
          {region !== 'all' ? '该地区暂无内容' : '该分类暂无内容'}
        </p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {items.map((item) => (
            <BrowseCard
              key={`${item.sourceKey}_${item.vodId}_${item.name}`}
              item={item}
              selectMode={batch.selectMode}
              checked={batch.selected.has(itemKey(item))}
              onClick={() => onOpen(item)}
              onToggleSelect={() => batch.toggle(itemKey(item))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** 热门剧集卡片：封面 + 剧名 + 「N 源」徽章；多选模式下叠加复选框 */
function BrowseCard({
  item,
  onClick,
  selectMode = false,
  checked = false,
  onToggleSelect,
}: {
  item: BrowseItem;
  onClick: () => void;
  selectMode?: boolean;
  checked?: boolean;
  onToggleSelect?: () => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [item.pic]);

  // 源站已给豆瓣分的沿用源站数据（零请求）；只有缺分时才让三方评分站补
  const isAdult = item.category === 'adult';
  const needRating = item.doubanScore === undefined && !isAdult;
  const ratingTarget = useMemo<RatingTarget>(
    () => ({ title: item.name, year: item.year, typeName: item.typeName, adult: isAdult }),
    [item.name, item.year, item.typeName, isAdult]
  );
  const rating = useRating(ratingTarget);
  // 热门一屏几十张卡，进视口才入队：滚过去的部分不占用三方请求预算
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>(needRating);
  useRatingAutoFill(needRating && inView, [ratingTarget]);

  return (
    <div
      ref={inViewRef}
      className={cn(
        'card cursor-pointer hover:scale-[1.03] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        selectMode && 'relative',
        checked && 'ring-2 ring-accent'
      )}
      role="button"
      tabIndex={0}
      onClick={() => (selectMode ? onToggleSelect?.() : onClick())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectMode) onToggleSelect?.();
          else onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] bg-chip">
        {item.pic && !imgFailed ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="w-full h-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-chip">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H8a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z"
              />
            </svg>
          </div>
        )}
        {/* 多选模式：左上角复选框 */}
        {selectMode && (
          <span
            className={cn(
              'absolute top-1.5 left-1.5 w-5 h-5 rounded flex items-center justify-center border-2 transition-colors',
              checked ? 'bg-accent border-accent text-on-accent' : 'bg-black/60 border-white/80'
            )}
            aria-hidden
          >
            {checked && (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </span>
        )}
        {/* 多源收录徽章：最直观的热度信号 */}
        {!selectMode && item.sourceCount > 1 && (
          <span
            className="absolute top-1.5 left-1.5 tag bg-black/70 text-white font-medium"
            title={`${item.sourceCount} 个源都有：${item.sources.map((s) => s.sourceName).join('、')}`}
          >
            {item.sourceCount} 源
          </span>
        )}
        {item.doubanScore !== undefined ? (
          <span className="absolute top-1.5 right-1.5 tag bg-black/70 text-rating font-medium">
            ★ {item.doubanScore}
          </span>
        ) : (
          rating && (
            <span
              className="absolute top-1.5 right-1.5 tag bg-black/70 text-rating font-medium tabular-nums"
              title={ratingTooltip(rating)}
            >
              ★ {rating.score.toFixed(1)}
            </span>
          )
        )}
      </div>
      <div className="p-2">
        <div className="text-xs font-medium text-content truncate" title={item.name}>
          {item.name}
        </div>
        <div className="text-[11px] text-faint truncate mt-0.5">
          {[item.year, item.area || item.typeName].filter(Boolean).join(' · ') || item.sourceName}
        </div>
      </div>
    </div>
  );
}

function BrowseSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }, (_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}
