'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { detectBasePath, withBasePath } from '@/lib/base-path';
import { Drawer } from './drawer';
import { Icon, type IconName } from './icon';
import { requestShowDownloadManager } from './download-manager';
import { requestShowServerDownload } from './server-download-center';

type Props = {
  hidden?: boolean;
  onHistory?: () => void;
  onSettings?: () => void;
  onEpisodes?: () => void;
  onSwitch?: () => void;
};

/** Thumb-accessible navigation, sharing the existing React drawers and actions. */
export function MobileNavigation({ hidden, onHistory, onSettings, onEpisodes, onSwitch }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const base = detectBasePath(pathname);
  const href = (path: string) => withBasePath(path, base);
  const [moreOpen, setMoreOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const watching = !!onEpisodes;
  const mangaBrowsing = pathname === href('/manga') || pathname.startsWith(href('/manga/'));

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setKeyboardOpen(
      !!viewport && window.innerHeight - viewport.height > 140 &&
      /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')
    );
    viewport?.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);

  const search = () => {
    const input = document.querySelector<HTMLInputElement>(mangaBrowsing ? 'main input[aria-label="搜索漫画"]' : 'main input[aria-label="搜索影片"]');
    if (input) {
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus({ preventScroll: true });
    } else router.push(`${href(mangaBrowsing ? '/manga' : '/')}?mobileAction=search`);
  };
  const panel = (name: 'history' | 'settings') => {
    const open = name === 'history' ? onHistory : onSettings;
    if (open) open();
    else router.push(`${href('/')}?mobileAction=${name}`);
  };
  const button = (label: string, icon: IconName, action: () => void) => (
    <button type="button" onClick={action} aria-label={label}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );

  return <>
    <nav id="lt-mobile-nav" aria-label="手机快捷导航" hidden={hidden || keyboardOpen}>
      <Link href={href('/')} aria-current={pathname === href('/') ? 'page' : undefined}>
        <Icon name="home" /><span>首页</span>
      </Link>
      {watching ? button('选集', 'layers', () => onEpisodes?.()) : mangaBrowsing ?
        <Link href={href('/manga')} aria-current={pathname === href('/manga') ? 'page' : undefined}><Icon name="layers" /><span>漫画</span></Link> :
        <Link href={href('/live')} aria-current={pathname === href('/live') ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path strokeWidth="1.8" strokeLinejoin="round" d="M4 7h16v14H4ZM8 2l4 5 4-5M10 11l5 3-5 3Z" /></svg><span>直播</span>
        </Link>}
      {watching ? button('换源', 'refresh', () => onSwitch?.()) : button('搜索', 'search', search)}
      {mangaBrowsing ? <Link href={href('/manga/local')} aria-current={pathname === href('/manga/local') ? 'page' : undefined}><Icon name="home" /><span>本地</span></Link> : button('历史', 'clock', () => panel('history'))}
      {button('更多', 'gear', () => setMoreOpen(true))}
    </nav>
    <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} title="更多功能">
      <div className="lt-menu-grid">
        {([['片源与设置', 'gear', () => panel('settings')],
          ['观看历史', 'clock', () => panel('history')],
          ['下载管理', 'download', requestShowDownloadManager],
          ['批量下载', 'layers', requestShowServerDownload]] as const).map(([label, icon, action]) =>
          <button key={label} type="button" onClick={() => { setMoreOpen(false); window.setTimeout(action, 220); }}>
            <Icon name={icon} /><span>{label}</span>
          </button>)}
        {([['漫画', '/manga'], ['本地漫画', '/manga/local'], ['系统管理', '/system'], ['隐私', '/privacy'], ['关于', '/about']] as const).map(([label, path]) =>
          <Link key={path} href={href(path)} onClick={() => setMoreOpen(false)}><Icon name="link" /><span>{label}</span></Link>)}
      </div>
    </Drawer>
  </>;
}
