'use client';

import { Suspense, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { Spinner } from '@/components/states';
import { detectBasePath, withBasePath } from '@/lib/base-path';

/**
 * 本地漫画库。
 *
 * 与 `/manga`（在线源）是两条独立的路：这里的内容全部来自服务端
 * `LOCAL_MANGA_DIR` 指向的目录，**不打任何在线源、不做任何抓取**。
 * 放什么进来由使用者自己决定，系统只负责扫目录、出封面、给阅读器。
 */
const CHAPTER_PAGE = 60;

function LocalLibraryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = detectBasePath(pathname);

  // 刷新计数：0 用服务端索引缓存，点过刷新之后每次都强制重扫
  const [refreshKey, setRefreshKey] = useState(0);
  // 展开章节列表的作品
  const [openId, setOpenId] = useState<string | null>(null);
  // 长作品（合集常有几百章）先只渲染一批，点「显示更多」再加
  const [shownChapters, setShownChapters] = useState(CHAPTER_PAGE);

  const lib = useQuery({
    queryKey: ['manga-local', refreshKey],
    queryFn: ({ signal }) => api.mangaLocalLibrary({ refresh: refreshKey > 0 }, signal),
  });

  // 章节列表按需取：点开哪部才取哪部，进页面时不把整库章节都拉一遍
  const detail = useQuery({
    queryKey: ['manga-local-detail', openId],
    queryFn: ({ signal }) => api.mangaDetail(openId as string, {}, signal),
    enabled: !!openId,
  });

  const data = lib.data;
  const works = data?.works ?? [];

  const read = (workId: string, chapterId: string) => {
    router.push(
      `${withBasePath('/manga/read', basePath)}?id=${encodeURIComponent(workId)}&c=${encodeURIComponent(chapterId)}`
    );
  };

  const toggle = (id: string) => {
    setShownChapters(CHAPTER_PAGE);
    setOpenId((cur) => (cur === id ? null : id));
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-content">本地漫画</h1>
            <p className="text-sm text-muted mt-1 break-all">
              {data?.configured
                ? `共 ${data.total} 部 · ${data.root}`
                : '还没有配置书库目录'}
            </p>
          </div>
          {data?.configured && (
            <button
              type="button"
              className="shrink-0 px-3 py-1.5 rounded-lg bg-chip border border-line text-sm text-muted hover:text-content disabled:opacity-40"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={lib.isFetching}
            >
              {lib.isFetching ? '扫描中…' : '刷新书库'}
            </button>
          )}
        </div>

        {lib.isPending && (
          <div className="flex justify-center py-24">
            <Spinner />
          </div>
        )}

        {!lib.isPending && data && !data.configured && (
          <div className="rounded-xl border border-line bg-chip/40 p-5 text-sm text-muted leading-relaxed">
            <p className="text-content font-medium mb-2">先配置书库目录</p>
            <p>
              在项目根目录的 <code className="px-1 rounded bg-chip">.env</code> 里加一行，然后重启服务：
            </p>
            <pre className="mt-2 p-3 rounded-lg bg-black/30 text-xs overflow-x-auto text-content">
              {`LOCAL_MANGA_DIR=D:\\\\Manga`}
            </pre>
            <p className="mt-3">目录里的作品按下面两种方式放都可以：</p>
            <pre className="mt-2 p-3 rounded-lg bg-black/30 text-xs overflow-x-auto text-content">
{`书库/
├─ 作品A/                  ← 一部作品
│   ├─ 第 1 话/001.jpg …   ← 章节（子目录）
│   └─ 第 2 话/
├─ 作品B/001.jpg …         ← 目录下直接放图 = 单章
└─ 作品C.cbz               ← 压缩包 = 单章`}
            </pre>
            <p className="mt-3">
              章节本身也可以是压缩包（<code className="px-1 rounded bg-chip">作品A/第 1 话.cbz</code>）。
              页数按文件名里的数字排序，所以「第 2 话」会排在「第 10 话」前面。
            </p>
          </div>
        )}

        {!lib.isPending && data?.configured && works.length === 0 && (
          <div className="rounded-xl border border-line bg-chip/40 p-5 text-sm text-muted">
            <p>
              目录里还没扫到作品。把图片文件夹或 <code className="px-1 rounded bg-chip">.cbz</code>{' '}
              / <code className="px-1 rounded bg-chip">.zip</code> /{' '}
              <code className="px-1 rounded bg-chip">.tar.gz</code> 放进{' '}
              <span className="text-content break-all">{data.root}</span>，然后点「刷新书库」。
            </p>
            <SkippedList items={data.skipped} />
          </div>
        )}

        {!lib.isPending && works.length > 0 && (data?.skipped?.length ?? 0) > 0 && (
          <div className="mb-4 rounded-xl border border-line bg-chip/40 p-4 text-sm text-muted">
            <p className="text-content mb-1">有 {data?.skipped?.length} 个条目没被收录：</p>
            <SkippedList items={data?.skipped} />
          </div>
        )}

        {works.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {works.map((w) => {
              const open = openId === w.id;
              return (
                <div key={w.id} className="col-span-1">
                  <button
                    type="button"
                    onClick={() => toggle(w.id)}
                    className="group block w-full text-left"
                  >
                    <div className="relative aspect-[3/4] rounded-lg overflow-hidden bg-chip border border-line">
                      {w.cover ? (
                        // 封面已经是本站代理地址，直接用原生 img，不再套一层代理
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={w.cover}
                          alt={w.title}
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform group-hover:scale-105"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-faint">
                          无封面
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-content line-clamp-2 leading-snug">{w.title}</p>
                    <p className="text-xs text-faint">
                      {w.chapterCount} 章 · {w.pageCount} 页
                    </p>
                  </button>

                  {open && (
                    <div className="mt-2 rounded-lg border border-line bg-chip/40 p-2 max-h-56 overflow-y-auto">
                      {detail.isPending && <p className="text-xs text-faint px-1">读取章节…</p>}
                      {detail.isError && (
                        <p className="text-xs text-faint px-1">章节读取失败，试试刷新书库</p>
                      )}
                      {detail.data?.chapters?.length === 0 && (
                        <p className="text-xs text-faint px-1">没有章节</p>
                      )}
                      <div className="flex flex-col gap-1">
                        {(detail.data?.chapters ?? []).slice(0, shownChapters).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => read(w.id, c.id)}
                            className="text-left text-xs px-2 py-1.5 rounded hover:bg-chip text-muted hover:text-content truncate"
                          >
                            {c.title || '第 1 话'}
                            <span className="text-faint ml-1">{c.pages} 页</span>
                          </button>
                        ))}
                        {(detail.data?.chapters?.length ?? 0) > shownChapters && (
                          <button
                            type="button"
                            onClick={() => setShownChapters((n) => n + CHAPTER_PAGE)}
                            className="text-left text-xs px-2 py-1.5 rounded hover:bg-chip text-faint hover:text-content"
                          >
                            显示更多（还有 {(detail.data?.chapters?.length ?? 0) - shownChapters} 章）
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

/** 没被收录的条目：列出来，省得使用者对着空列表猜原因 */
function SkippedList({ items }: { items?: { name: string; reason: string }[] }) {
  const list = items ?? [];
  if (list.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs">
      {list.slice(0, 8).map((s) => (
        <li key={s.name} className="flex gap-2">
          <span className="text-faint shrink-0">·</span>
          <span className="min-w-0">
            <span className="text-content break-all">{s.name}</span>
            <span className="text-faint"> — {s.reason}</span>
          </span>
        </li>
      ))}
      {list.length > 8 && <li className="text-faint">…还有 {list.length - 8} 个</li>}
    </ul>
  );
}

export default function LocalMangaPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <LocalLibraryContent />
    </Suspense>
  );
}
