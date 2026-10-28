'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { Spinner } from '@/components/states';
import { detectBasePath, withBasePath } from '@/lib/base-path';
import { cn } from '@/lib/utils';
import { markRecordReplace } from '@/lib/nav-history';
import { Drawer } from '@/components/drawer';
import { MangaReaderImage } from '@/components/manga-reader-image';
import { BackButton } from '@/components/back-button';

function MangaReadContent() {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = detectBasePath(pathname);
  const searchParams = useSearchParams();

  const mangaId = (searchParams.get('id') || '').trim();
  const chapterId = (searchParams.get('c') || '').trim();

  // 当前页码（0 起）
  const [page, setPage] = useState(0);
  // 阅读模式：单页 / 条漫（竖向连续滚动）
  const [webtoon, setWebtoon] = useState(false);
  const [modeReady, setModeReady] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [chapterQuery, setChapterQuery] = useState('');
  const [chapterLimit, setChapterLimit] = useState(100);
  const pageFrame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { setWebtoon(localStorage.getItem('libretv-manga-reading-mode') === 'webtoon'); } catch { /* private storage */ }
    setModeReady(true);
  }, []);
  useEffect(() => {
    if (!modeReady) return;
    try { localStorage.setItem('libretv-manga-reading-mode', webtoon ? 'webtoon' : 'single'); } catch { /* private storage */ }
  }, [webtoon, modeReady]);

  const detailQuery = useQuery({
    queryKey: ['manga-detail', mangaId],
    queryFn: ({ signal }) => api.mangaDetail(mangaId, {}, signal),
    enabled: mangaId.length > 0,
  });

  const pagesQuery = useQuery({
    queryKey: ['manga-pages', chapterId],
    queryFn: ({ signal }) => api.mangaPages(chapterId, signal),
    enabled: chapterId.length > 0,
  });

  const manga = detailQuery.data;
  const chapters = useMemo(() => manga?.chapters ?? [], [manga]);
  const images = pagesQuery.data?.images ?? [];

  // 当前章在列表中的下标
  const chapterIndex = useMemo(
    () => chapters.findIndex((c) => c.id === chapterId),
    [chapters, chapterId]
  );
  const chapter = chapterIndex >= 0 ? chapters[chapterIndex] : null;

  const matchingChapters = useMemo(() => {
    const q = chapterQuery.trim().toLocaleLowerCase();
    return chapters.filter((c, i) => !q || `${c.number || i + 1} ${c.title || ''}`.toLocaleLowerCase().includes(q));
  }, [chapters, chapterQuery]);

  useEffect(() => {
    if (!webtoon && page > 0) pageFrame.current?.scrollIntoView({ block: 'start' });
  }, [page, webtoon]);

  // 切章时回到第 1 页
  useEffect(() => setPage(0), [chapterId]);

  const goChapter = useCallback(
    (cid: string) => {
      markRecordReplace();
      router.replace(`${withBasePath('/manga/read', basePath)}?id=${encodeURIComponent(mangaId)}&c=${encodeURIComponent(cid)}`, {
        scroll: true,
      });
      setCatalogOpen(false);
      setPage(0);
    },
    [router, basePath, mangaId]
  );

  const nextChapter = useCallback(() => {
    if (chapterIndex >= 0 && chapterIndex + 1 < chapters.length) goChapter(chapters[chapterIndex + 1].id);
  }, [chapterIndex, chapters, goChapter]);

  const prevChapter = useCallback(() => {
    if (chapterIndex > 0) goChapter(chapters[chapterIndex - 1].id);
  }, [chapterIndex, chapters, goChapter]);

  // 键盘翻页：←/→ 翻页，Shift+←/→ 翻章
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input,textarea,select,button,a,[contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"]') || images.length === 0) return;
      if (['ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      if (webtoon) return; // 条漫模式用滚轮
      if (e.shiftKey && e.key === 'ArrowRight') nextChapter();
      else if (e.shiftKey && e.key === 'ArrowLeft') prevChapter();
      else if (e.key === 'ArrowRight' || e.key === ' ') setPage((p) => Math.min(images.length - 1, p + 1));
      else if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, webtoon, nextChapter, prevChapter]);

  if (!mangaId || !chapterId) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header hideMobileNavigation />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-sm text-muted mb-4">缺少漫画或章节参数</p>
            <button className="btn-primary px-4 py-2 rounded-lg text-sm" onClick={() => router.push(withBasePath('/manga', basePath))}>
              去漫画首页
            </button>
          </div>
        </main>
      </div>
    );
  }

  const loading = detailQuery.isPending || pagesQuery.isPending;

  return (
    <div className="min-h-screen flex flex-col bg-black">
      <Header hideMobileNavigation />

      <main className="lt-manga-reader flex-1 w-full max-w-3xl mx-auto px-4 py-4">
        {/* 标题栏 */}
        <div className="lt-reader-heading flex items-start justify-between gap-3 mb-3">
          {/* 桌面客户端没有浏览器后退键：阅读器必须自带出口，否则翻几章就退不出去 */}
          <BackButton withLabel className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-content truncate">{manga?.title || '加载中...'}</h1>
            <p className="text-xs text-faint mt-0.5">
              {chapter
                ? `${chapter.number ? `第 ${chapter.number} 话` : '特别篇'}${chapter.title ? ` · ${chapter.title}` : ''} · ${images.length} 页`
                : '章节加载中...'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              aria-pressed={webtoon}
              onClick={() => setWebtoon((v) => !v)}
              className="px-2.5 py-1 rounded-md bg-chip border border-line text-xs text-muted hover:text-content transition-colors"
              title={webtoon ? '切换到单页模式' : '切换到条漫模式（竖向连续滚动）'}
            >
              {webtoon ? '单页' : '条漫'}
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex justify-center py-24">
            <Spinner size="lg" />
          </div>
        )}

        {pagesQuery.isError && (
          <div className="text-center py-24 text-sm text-muted">
            <p>图片加载失败：{(pagesQuery.error as Error)?.message || '请重试'}</p>
            <button type="button" className="btn-primary mt-4" onClick={() => { void pagesQuery.refetch(); }}>重新加载章节</button>
          </div>
        )}

        {/* 单页模式 */}
        {!loading && !webtoon && images.length > 0 && (
          <>
            <div ref={pageFrame} className="lt-reader-page relative rounded-lg overflow-hidden bg-white/[0.03] border border-line">
              <MangaReaderImage key={images[page]} src={images[page]} page={page + 1} />
              {/* 点击左右区域翻页 */}
              <button
                type="button"
                aria-label="上一页"
                disabled={page === 0}
                className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              />
              <button
                type="button"
                aria-label="下一页"
                disabled={page >= images.length - 1}
                className="absolute inset-y-0 right-0 w-2/3 cursor-e-resize"
                onClick={() => setPage((p) => Math.min(images.length - 1, p + 1))}
              />
            </div>

            {/* 翻页控制条 */}
            <div className="lt-reader-inline-controls flex items-center justify-between mt-3 text-xs text-faint">
              <span>
                {page + 1} / {images.length}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-md bg-chip border border-line hover:text-content disabled:opacity-40"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-md bg-chip border border-line hover:text-content disabled:opacity-40"
                  disabled={page >= images.length - 1}
                  onClick={() => setPage((p) => Math.min(images.length - 1, p + 1))}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}

        {/* 条漫模式：竖向连续滚动 */}
        {!loading && webtoon && images.length > 0 && (
          <div className="space-y-1">
            {images.map((src, i) => <MangaReaderImage key={`${chapterId}-${i}`} src={src} page={i + 1} lazy={i > 1} />)}
          </div>
        )}

        {/* 章节切换 */}
        <div className="lt-reader-inline-chapters flex items-center justify-between gap-2 mt-6 pt-4 border-t border-line">
          <button
            type="button"
            className="px-3 py-1.5 rounded-md bg-chip border border-line text-xs text-muted hover:text-content disabled:opacity-40"
            disabled={chapterIndex <= 0}
            onClick={prevChapter}
          >
            ← 上一章
          </button>
          <span className="text-xs text-faint">
            {chapterIndex >= 0 ? `${chapterIndex + 1} / ${chapters.length}` : '-'}
          </span>
          <button
            type="button"
            className="px-3 py-1.5 rounded-md bg-chip border border-line text-xs text-muted hover:text-content disabled:opacity-40"
            disabled={chapterIndex < 0 || chapterIndex >= chapters.length - 1}
            onClick={nextChapter}
          >
            下一章 →
          </button>
        </div>

        {/* 章节目录 */}
        {chapters.length > 1 && (
          <details className="lt-reader-inline-catalog mt-4">
            <summary className="text-xs text-muted cursor-pointer hover:text-content">章节目录（{chapters.length} 话）</summary>
            <div className="mt-2 max-h-64 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {chapters.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => goChapter(c.id)}
                  className={cn(
                    'px-2 py-1.5 rounded-md border text-xs text-left truncate transition-colors',
                    c.id === chapterId
                      ? 'border-accent text-content bg-chip'
                      : 'border-line text-muted hover:text-content'
                  )}
                  title={`${c.number ? `第 ${c.number} 话` : '特别篇'}${c.title ? ` · ${c.title}` : ''}`}
                >
                  {c.number ? `第 ${c.number} 话` : `#${i + 1}`}
                  {c.title ? ` ${c.title}` : ''}
                </button>
              ))}
            </div>
          </details>
        )}
      </main>

      <nav id="manga-reader-controls" aria-label="漫画阅读控制" hidden={catalogOpen}>
        <button type="button" disabled={loading || (webtoon ? chapterIndex <= 0 : page === 0)}
          onClick={webtoon ? prevChapter : () => setPage(p => Math.max(0, p - 1))}>{webtoon ? '上一章' : '上一页'}</button>
        <button type="button" onClick={() => setCatalogOpen(true)} disabled={chapters.length === 0}>目录<span>{webtoon ? `${Math.max(0, chapterIndex + 1)}/${chapters.length} 章` : `${images.length ? page + 1 : 0}/${images.length} 页`}</span></button>
        <button type="button" aria-pressed={webtoon} onClick={() => setWebtoon(v => !v)}>{webtoon ? '切换单页' : '切换条漫'}</button>
        <button type="button" disabled={loading || (webtoon ? chapterIndex < 0 || chapterIndex >= chapters.length - 1 : images.length === 0 || (page >= images.length - 1 && chapterIndex >= chapters.length - 1))}
          onClick={webtoon || page >= images.length - 1 ? nextChapter : () => setPage(p => Math.min(images.length - 1, p + 1))}>{webtoon || (images.length > 0 && page >= images.length - 1 && chapterIndex + 1 < chapters.length) ? '下一章' : '下一页'}</button>
      </nav>
      <Drawer open={catalogOpen} onClose={() => setCatalogOpen(false)} title="章节目录" subheader={
        <input className="input w-full" aria-label="搜索章节" placeholder="输入章节号或标题" value={chapterQuery}
          onChange={e => { setChapterQuery(e.target.value); setChapterLimit(100); }} />
      }>
        <p className="text-xs text-muted mb-3" role="status">{matchingChapters.length} 个章节 · 当前第 {Math.max(0, chapterIndex + 1)} 章</p>
        <div className="lt-chapter-catalog">
          {matchingChapters.slice(0, chapterLimit).map(c => <button type="button" key={c.id}
            aria-current={c.id === chapterId ? 'page' : undefined} onClick={() => goChapter(c.id)}>
            {c.number ? `第 ${c.number} 话` : '特别篇'}{c.title ? ` · ${c.title}` : ''}
          </button>)}
        </div>
        {matchingChapters.length === 0 && <p className="text-sm text-muted py-6">没有匹配章节，试试章节号。</p>}
        {matchingChapters.length > chapterLimit && <button type="button" className="btn-ghost w-full mt-3" onClick={() => setChapterLimit(n => n + 100)}>显示更多章节</button>}
      </Drawer>
      <SiteFooter />
    </div>
  );
}

export default function MangaReadPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-black">
          <Spinner size="lg" />
        </div>
      }
    >
      <MangaReadContent />
    </Suspense>
  );
}
