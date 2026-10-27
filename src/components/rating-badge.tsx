'use client';

import type { RatingInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 来源标签：豆瓣与 TMDB 的评分口径不同，混在一起不做区分会误导 */
const PROVIDER_LABEL: Record<RatingInfo['provider'], string> = {
  douban: '豆瓣',
  tmdb: 'TMDB',
};

export function ratingProviderLabel(provider: RatingInfo['provider']): string {
  return PROVIDER_LABEL[provider];
}

function formatVotes(votes: number | undefined): string {
  if (!votes || votes <= 0) return '';
  if (votes >= 100_000_000) return `${(votes / 100_000_000).toFixed(1)}亿人评分`;
  if (votes >= 10_000) return `${(votes / 10_000).toFixed(1)}万人评分`;
  return `${votes}人评分`;
}

/** 完整提示文案：「豆瓣 8.7 · 121万人评分 · 周处除三害(2023)」 */
export function ratingTooltip(rating: RatingInfo): string {
  return tooltipOf(rating);
}

function tooltipOf(rating: RatingInfo): string {
  const parts = [`${PROVIDER_LABEL[rating.provider]} ${rating.score.toFixed(1)}`];
  const votes = formatVotes(rating.votes);
  if (votes) parts.push(votes);
  if (rating.title) parts.push(rating.year ? `${rating.title}(${rating.year})` : rating.title);
  return parts.join(' · ');
}

/**
 * 色阶：高分醒目、低分弱化。
 * 与股价不同，这里是评分——统一用琥珀色的深浅表达「好不好看」，不引入红绿。
 */
function toneClass(score: number): string {
  if (score >= 8) return 'bg-rating/20 text-rating';
  if (score >= 6) return 'bg-chip text-content';
  return 'bg-chip text-muted';
}

/** 卡片上的紧凑徽章：★ 8.7 */
export function RatingBadge({
  rating,
  className,
  pending,
}: {
  rating?: RatingInfo | null;
  className?: string;
  /** 已入队但还没回来：占位一个等宽位置，避免评分到达时布局跳动 */
  pending?: boolean;
}) {
  if (pending) {
    return <span className={cn('tag bg-chip text-faint tabular-nums', className)}>★★</span>;
  }
  if (!rating) return null;
  return (
    <span
      className={cn('tag font-medium tabular-nums', toneClass(rating.score), className)}
      title={tooltipOf(rating)}
      aria-label={tooltipOf(rating)}
    >
      ★ {rating.score.toFixed(1)}
    </span>
  );
}

/** 详情页的完整一行：「豆瓣 8.7 · 121万人评分」 */
export function RatingLine({ rating, className }: { rating?: RatingInfo | null; className?: string }) {
  if (!rating) return null;
  const votes = formatVotes(rating.votes);
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-sm font-medium tabular-nums', className)}
      title={tooltipOf(rating)}
    >
      <span className={rating.score >= 8 ? 'text-rating' : 'text-content'}>
        ★ {rating.score.toFixed(1)}
      </span>
      <span className="text-muted font-normal">
        {PROVIDER_LABEL[rating.provider]}
        {votes ? ` · ${votes}` : ''}
      </span>
    </span>
  );
}
