'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { recordVisit } from '@/lib/nav-history';

/**
 * 记录站内页面访问，供「返回上一级」使用（见 lib/nav-history.ts 的说明）。
 *
 * 挂在 Providers 里而不是 Header 里：播放页不渲染 Header，
 * 挂错地方会导致「搜索结果 → 播放页」这一步没被记录，返回又退回首页。
 *
 * 必须放在 Suspense 内：useSearchParams 在静态渲染阶段不可用。
 */
export function NavHistoryTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => {
    recordVisit(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);

  return null;
}
