'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MobileNavigation } from './mobile-navigation';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { requestShowServerDownload } from './server-download-center';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';
import { detectBasePath, withBasePath } from '@/lib/base-path';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false, hideMobileNavigation = false }: { showSearch?: boolean; hideMobileNavigation?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  // 客户端（/app/ 前缀）下站内链接需带上前缀，否则会跳到控制面板自己的首页
  const basePath = detectBasePath(pathname);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    // 客户端（/app/ 前缀）下需带上前缀，否则会跳到控制面板首页
    router.push(`${withBasePath('/', basePath)}?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索（此前只有首页会记录）
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('mobileAction');
    if (!action) return;
    params.delete('mobileAction');
    window.history.replaceState(window.history.state, '', window.location.pathname + (params.size ? `?${params}` : '') + window.location.hash);
    if (action === 'history') setHistoryOpen(true);
    if (action === 'settings') setSettingsOpen(true);
    if (action === 'search') {
      const timer = window.setTimeout(() => document.querySelector<HTMLInputElement>('main input[aria-label="搜索漫画"],main input[aria-label="搜索影片"]')?.focus(), 200);
      return () => window.clearTimeout(timer);
    }
  }, [pathname]);

  return (
    <>
      <header className="lt-site-header sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            href={withBasePath('/', basePath)}
            aria-label="LibreTV 首页"
            className="flex items-center shrink-0"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512.png" alt="LibreTV" className="w-7 h-7 rounded-lg" />
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-9',
                    // 展开时：上圆角与外框沿用聚焦样式，底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible &&
                      'rounded-b-none border-accent border-b-line bg-surface-raised focus-visible:ring-0'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索影片..."
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          <div className="flex-1 sm:hidden" />

          <nav className="flex items-center gap-1 ml-auto">
            <HeaderLink
              href={withBasePath('/live', basePath)}
              active={pathname === '/live' || pathname === '/app/live'}
            >
              直播
            </HeaderLink>
            <HeaderLink
              href={withBasePath('/manga', basePath)}
              active={pathname === '/manga' || pathname === '/app/manga'}
            >
              漫画
            </HeaderLink>
            <HeaderLink
              href={withBasePath('/manga/local', basePath)}
              active={pathname === '/manga/local' || pathname === '/app/manga/local'}
            >
              本地漫画
            </HeaderLink>
            <HeaderLink
              href={withBasePath('/system', basePath)}
              active={pathname === '/system' || pathname === '/app/system'}
            >
              系统
            </HeaderLink>
            <HeaderLink
              href={withBasePath('/privacy', basePath)}
              active={pathname === '/privacy' || pathname === '/app/privacy'}
            >
              隐私
            </HeaderLink>
            <HeaderLink
              href={withBasePath('/about', basePath)}
              active={pathname === '/about' || pathname === '/app/about'}
            >
              关于
            </HeaderLink>
            <ThemeToggle />
            <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" />
            </IconButton>
            <IconButton label="下载管理" onClick={requestShowDownloadManager}>
              <Icon name="download" />
            </IconButton>
            <IconButton label="批量下载中心" onClick={requestShowServerDownload}>
              <Icon name="layers" />
            </IconButton>
            <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
              <Icon name="gear" />
            </IconButton>
          </nav>
        </div>
      </header>

      {!hideMobileNavigation && <MobileNavigation hidden={settingsOpen || historyOpen} onHistory={() => setHistoryOpen(true)} onSettings={() => setSettingsOpen(true)} />}
      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

function HeaderLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-2.5 py-1.5 rounded-md text-sm transition-colors',
        active ? 'text-content bg-hover' : 'text-muted hover:text-content'
      )}
    >
      {children}
    </Link>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
