'use client';

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/lib/store';
import {
  applyContentFilter,
  isAdultContent,
  parseRating,
  type ContentFilterMode,
} from '@/lib/content-filter';
import type { BrowseItem, DoubanItem } from '@/lib/types';

/**
 * 内容筛选的统一入口（首页所有内容区共用）。
 *
 * 两条规则，按顺序：
 * 1. **成人内容无条件剔除**——只看「成人内容过滤」开关，与「全选 / 只看有评分」无关。
 *    否则「全选」模式下成人条目会漏出来，隐私保护形同虚设。
 * 2. **评分门槛**——仅在「只看有评分」模式下生效：保留有评分且评分 ≥ 门槛的条目。
 *
 * 不同内容区的评分来源不同（豆瓣推荐/周榜有豆瓣分，百度热播剧与 Bangumi 无评分），
 * 因此「只看有评分」会把后两者全部滤掉——这是预期行为：
 * 它们本就没有评分信息，该模式的意思是「宁缺毋滥，只看有口碑的」。
 */
export function useContentFilter() {
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const mode = useAppStore((s) => s.contentFilterMode);
  const minRating = useAppStore((s) => s.contentMinRating);

  const settings = useMemo(() => ({ mode, minRating }), [mode, minRating]);

  /** 筛选推荐类条目（豆瓣推荐 / 周榜 / 百度热播剧 / Bangumi） */
  const filterRecommended = useCallback(
    <T extends DoubanItem>(items: T[]): T[] => {
      if (!yellowFilter) {
        // 过滤关闭时仍按评分门槛筛（评分门槛与成人开关是两件事）
        return applyContentFilter(items, settings, () => false);
      }
      return applyContentFilter(items, settings, (item) => isAdultContent({ title: item.title }));
    },
    [yellowFilter, settings]
  );

  /** 筛选热门剧集条目（自带分类名，判定更准） */
  const filterBrowse = useCallback(
    (items: BrowseItem[]): BrowseItem[] => {
      if (!yellowFilter) {
        return applyContentFilter(items, settings, () => false);
      }
      return applyContentFilter(
        items,
        { ...settings, mode: settings.mode },
        (item) => isAdultContent({ typeName: item.typeName, name: item.name })
      );
    },
    [yellowFilter, settings]
  );

  return { mode, minRating, settings, filterRecommended, filterBrowse, parseRating };
}

export type { ContentFilterMode };
