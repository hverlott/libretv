'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { detectBasePath, withBasePath } from '@/lib/base-path';
import { previousPath, truncateTo } from '@/lib/nav-history';
import { cn } from '@/lib/utils';

/**
 * 返回上一级。
 *
 * 优先级：站内导航记录 → 首页。
 * 刻意**不用** router.back()：
 * - 桌面客户端的历史栈里有控制面板页，back 会跳出 LibreTV；
 * - 从外部链接直接进来时 back 会离开站点。
 *
 * `withLabel` 会在图标旁补一个「返回」字样：桌面客户端没有地址栏和后退键，
 * 一个 36px 的纯图标按钮在小窗口里很容易被当成装饰。
 */
export function BackButton({
  fallback = '/',
  withLabel = false,
  className,
  ariaLabel = '返回上一级',
}: {
  /** 没有导航记录时去哪里（默认首页） */
  fallback?: string;
  /** 是否显示「返回」文字 */
  withLabel?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const basePath = detectBasePath(pathname);

  const goBack = () => {
    const current = search ? `${pathname}?${search}` : pathname;
    const previous = previousPath(current);
    if (previous && previous !== current) {
      truncateTo(previous);
      // previous 来自 usePathname，已经含客户端前缀（如 /app），不能再拼一次
      router.push(previous);
      return;
    }
    router.push(withBasePath(fallback, basePath));
  };

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1 rounded-md text-muted hover:text-content hover:bg-hover transition-colors',
        withLabel ? 'px-2 h-9 -ml-2 text-sm' : 'p-2 -ml-2',
        className
      )}
      onClick={goBack}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      {withLabel && <span className="whitespace-nowrap">返回</span>}
    </button>
  );
}
