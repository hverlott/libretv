'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { Spinner } from '@/components/states';
import { SmartImage } from '@/components/smart-image';
import { detectBasePath, withBasePath } from '@/lib/base-path';
import {
  EXCLUDED_TAGS,
  MANGA_DEMOGRAPHICS,
  MANGA_LANGS,
  MANGA_ORIGINS,
  MANGA_RATINGS,
  MANGA_SORTS,
  MANGA_STATUSES,
  tagLabel,
} from '@/lib/mangadex-tags';
import { MANGA_SOURCES, resolveMangaSource, type MangaSourceId } from '@/lib/manga-source-meta';
import { useAppStore } from '@/lib/store';
import { ZAI_CATES, ZAI_SORTS, ZAI_STATUSES, ZAI_ZONES } from '@/lib/zaimanhua-tags';
import type { MangaItem, MangaSortKey } from '@/lib/types';

/** 每页条数（再漫画上游固定 20，多传也只会返回 20） */
const PAGE_SIZE = 24;

/** 标签分组显示名 */
const GROUP_LABEL: Record<string, string> = { genre: '题材', theme: '主题', format: '形式' };

function MangaContent() {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = detectBasePath(pathname);
  const searchParams = useSearchParams();

  // 本组件负责「分类浏览」与「搜索结果」两种形态；
  // 详情形态由外层 MangaRoute 分发到 MangaDetail。
  // 不能在这里早退——后面的 hooks 会变成条件调用，违反 react-hooks 规则。
  const q = (searchParams.get('q') || '').trim();
  /** 漫画源：省略时用默认源（再漫画） */
  const source = resolveMangaSource(searchParams.get('source'));
  const isZai = source === 'zaimanhua';

  const sortRaw = (searchParams.get('sort') || 'latest') as MangaSortKey;
  const sort = (isZai ? ZAI_SORTS : MANGA_SORTS).some((s) => s.key === sortRaw) ? sortRaw : 'latest';
  const demo = searchParams.get('demo') || '';
  const status = searchParams.get('status') || '';
  const lang = searchParams.get('lang') || '';
  const originRaw = (searchParams.get('origin') || '').trim();
  const origin = (isZai ? ZAI_ZONES : MANGA_ORIGINS).some((o) => o.key === originRaw) ? originRaw : '';
  const ratingRaw = (searchParams.get('rating') || '').trim();
  // 再漫画没有分级字段，这一档只在 MangaDex 侧生效
  const rating = !isZai && MANGA_RATINGS.some((r) => r.key === ratingRaw) ? ratingRaw : '';
  const tagKey = searchParams.get('tags') || '';
  const tags = useMemo(
    () => tagKey.split(',').map((s) => s.trim()).filter(Boolean),
    [tagKey]
  );

  /**
   * 全站「成人内容过滤」开关。
   * 开启时漫画侧连「含成人向」这个选项都不展示——与点播侧的成人源是同一套规则，
   * 免得出现「过滤开着但漫画这边还能手动打开」的割裂。
   */
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const adultAllowed = !yellowFilter && !isZai;
  // 选了任一成人档位（含成人向 / 限制级）都算成人浏览，并要把档位透传给接口
  const includeAdult = adultAllowed && rating !== '';

  const [input, setInput] = useState(q);
  const [moreOpen, setMoreOpen] = useState(false);

  // 输入框与 URL 同步：直接改地址栏 / 返回时也要回显
  useEffect(() => setInput(q), [q]);

  const isSearch = q.length > 0;

  /**
   * 分页用 `useInfiniteQuery` 而不是「自己存页码 + useQuery」：
   * 后者的 data 每次都被新一页**替换**，点「加载更多」只是换了一批卡片，
   * 看起来像没反应。无限查询会累积 pages，并且 queryKey 变化（换了筛选条件）
   * 时自动回到第一页，不用手动 reset。
   *
   * pageParam 是**页码（从 1 起）**而不是 offset：MangaDex 按 offset 翻页、
   * 再漫画按 page 翻页，用页码做中间表示，换算交给服务端。
   */
  const searchQuery = useInfiniteQuery({
    queryKey: ['manga-search', source, q, rating],
    queryFn: ({ pageParam, signal }) =>
      api.mangaSearch(
        q,
        { source, limit: PAGE_SIZE, page: pageParam, adult: includeAdult, rating: rating || undefined },
        signal
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total && lastPage.items.length > 0 ? allPages.length + 1 : undefined;
    },
    enabled: isSearch,
  });

  const browseQuery = useInfiniteQuery({
    queryKey: ['manga-browse', source, sort, demo, status, lang, origin, rating, tagKey, includeAdult],
    queryFn: ({ pageParam, signal }) =>
      api.mangaBrowse(
        {
          source,
          sort,
          demo: demo || null,
          status: status || null,
          lang: lang || null,
          origin: origin || null,
          rating: rating || null,
          tags,
          limit: PAGE_SIZE,
          page: pageParam,
          adult: includeAdult,
        },
        signal
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total && lastPage.items.length > 0 ? allPages.length + 1 : undefined;
    },
    enabled: !isSearch,
  });

  // 标签表几乎不变，缓存 12 小时，翻页时不会重复请求
  const tagsQuery = useQuery({
    queryKey: ['manga-tags', source],
    queryFn: ({ signal }) => api.mangaTags({ source }, signal),
    enabled: !isSearch,
    staleTime: 12 * 60 * 60 * 1000,
  });

  // 两种形态共用一套渲染，只是数据来源不同
  const pages = (isSearch ? searchQuery.data : browseQuery.data)?.pages;
  const items = useMemo<MangaItem[]>(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const total = pages?.[0]?.total ?? 0;
  const isPending = isSearch ? searchQuery.isPending : browseQuery.isPending;
  const isError = isSearch ? searchQuery.isError : browseQuery.isError;
  const error = (isSearch ? searchQuery.error : browseQuery.error) as Error | null;
  const isFetchingNextPage = isSearch
    ? searchQuery.isFetchingNextPage
    : browseQuery.isFetchingNextPage;
  const hasMore = isSearch ? searchQuery.hasNextPage : browseQuery.hasNextPage;

  const loadMore = useCallback(() => {
    if (isSearch) void searchQuery.fetchNextPage();
    else void browseQuery.fetchNextPage();
  }, [isSearch, searchQuery, browseQuery]);

  const submit = useCallback(
    (text: string) => {
      const kw = text.trim().slice(0, 60);
      if (!kw) return;
      router.push(
        `${withBasePath('/manga', basePath)}?source=${source}&q=${encodeURIComponent(kw)}`,
        { scroll: false }
      );
    },
    [router, basePath, source]
  );

  /** 筛选条件写回 URL：刷新、后退、分享链接都能还原当前视图 */
  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) sp.set(k, v);
        else sp.delete(k);
      }
      sp.delete('id');
      router.push(`${withBasePath('/manga', basePath)}?${sp.toString()}`, { scroll: false });
    },
    [router, basePath, searchParams]
  );

  /**
   * 切源：两个源的筛选取值完全不同，必须把旧条件清掉。
   * 否则会出现「再漫画的题材 id 被当成 MangaDex 标签 id 传上去」这类串味。
   */
  const switchSource = useCallback(
    (next: MangaSourceId) => {
      patchParams({
        source: next,
        tags: null,
        demo: null,
        status: null,
        lang: null,
        origin: null,
        rating: null,
        sort: null,
      });
    },
    [patchParams]
  );

  const toggleTag = useCallback(
    (id: string) => {
      // 再漫画的题材是单选（上游只有一个 theme 参数）；MangaDex 支持多选取 AND
      if (isZai) {
        patchParams({ tags: tags[0] === id ? null : id });
        return;
      }
      const next = tags.includes(id) ? tags.filter((t) => t !== id) : [...tags, id];
      patchParams({ tags: next.join(',') || null });
    },
    [tags, patchParams, isZai]
  );

  const openManga = useCallback(
    (id: string) => {
      // 成人档位必须带进详情页：详情与章节接口都按 contentRating 过滤，
      // 不带对应档位时限制级作品详情 404、章节列表返回 0 条
      const suffix = includeAdult && rating ? `&rating=${encodeURIComponent(rating)}` : '';
      router.push(
        `${withBasePath('/manga', basePath)}?id=${encodeURIComponent(id)}&source=${source}${suffix}`,
        { scroll: false }
      );
    },
    [router, basePath, includeAdult, rating, source]
  );

  const genreGroup = tagsQuery.data?.groups.find((g) => g.group === 'genre');
  const extraGroups = (tagsQuery.data?.groups || []).filter((g) => g.group !== 'genre');

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-content">漫画</h1>
          <p className="text-sm text-muted mt-1">
            {isZai
              ? '再漫画：中文漫画库，约 2 万部，可按地区（内地 / 日本 / 韩国 / 欧美 / 港台）、题材、受众、连载状态浏览。'
              : 'MangaDex：国际漫画社区，英文内容为主（中文译本约 642 部）。可按题材、受众、连载状态、语言、原作地区浏览；搜索时英文 / 罗马音关键词命中率更高。'}
          </p>
        </div>

        {/* 源切换 */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {MANGA_SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => switchSource(s.id)}
              title={s.hint}
              className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${
                source === s.id
                  ? 'bg-accent border-accent text-on-accent'
                  : 'bg-chip border-line text-muted hover:text-content hover:border-accent'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 搜索框 */}
        <form
          className="flex gap-2 mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入漫画名称（英文或中文）..."
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-chip border border-line text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent"
          />
          <button type="submit" className="btn-primary px-4 py-2 rounded-lg text-sm shrink-0">
            搜索
          </button>
          {isSearch && (
            <button
              type="button"
              onClick={() => patchParams({ q: null })}
              className="px-3 py-2 rounded-lg bg-chip border border-line text-sm text-muted hover:text-content shrink-0"
            >
              返回浏览
            </button>
          )}
        </form>

        {isSearch ? (
          <MangaGrid
            items={items}
            total={total}
            hasMore={hasMore}
            isPending={isPending}
            isError={isError}
            error={error}
            isFetching={isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={openManga}
            emptyHint={`没有找到「${q}」相关漫画。试试英文名称？`}
          />
        ) : (
          <>
            {/* 排序 */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(isZai ? ZAI_SORTS : MANGA_SORTS).map((s) => (
                <FilterChip
                  key={s.key}
                  active={sort === s.key}
                  onClick={() => patchParams({ sort: s.key })}
                >
                  {s.label}
                </FilterChip>
              ))}
            </div>

            {/* 地区 / 受众 / 状态 / 语言 / 分级 */}
            <div className="space-y-2 mb-4">
              <FilterRow
                label="地区"
                options={isZai ? ZAI_ZONES : MANGA_ORIGINS}
                value={origin}
                onChange={(v) => patchParams({ origin: v })}
              />
              <FilterRow
                label="受众"
                options={isZai ? ZAI_CATES : MANGA_DEMOGRAPHICS}
                value={demo}
                onChange={(v) => patchParams({ demo: v })}
              />
              <FilterRow
                label="状态"
                options={isZai ? ZAI_STATUSES : MANGA_STATUSES}
                value={status}
                onChange={(v) => patchParams({ status: v })}
              />
              {/* 语言与分级只有 MangaDex 有：再漫画内容本身全是中文，也没有分级字段 */}
              {!isZai && (
                <FilterRow
                  label="语言"
                  options={MANGA_LANGS}
                  value={lang}
                  onChange={(v) => patchParams({ lang: v })}
                />
              )}
              {adultAllowed && (
                <FilterRow
                  label="分级"
                  options={MANGA_RATINGS}
                  value={rating}
                  onChange={(v) => patchParams({ rating: v })}
                  hint="限制级含成人向"
                />
              )}
            </div>

            {/* 题材 */}
            {genreGroup && (
              <div className="mb-3">
                <p className="text-xs text-faint mb-1.5">题材</p>
                <div className="flex flex-wrap gap-1.5">
                  {genreGroup.tags.map((t) => (
                    <FilterChip key={t.id} active={tags.includes(t.id)} onClick={() => toggleTag(t.id)}>
                      {t.zh}
                    </FilterChip>
                  ))}
                </div>
              </div>
            )}

            {/* 更多筛选：主题 / 形式（默认收起，避免首屏太重） */}
            {extraGroups.length > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setMoreOpen((o) => !o)}
                  className="text-xs text-accent hover:underline"
                >
                  {moreOpen ? '收起更多筛选' : '更多筛选（主题 / 形式）'}
                  {tags.length > 0 ? ` · 已选 ${tags.length} 个标签` : ''}
                </button>
                {moreOpen && (
                  <div className="mt-2 space-y-2">
                    {extraGroups.map((g) => (
                      <TagSection
                        key={g.group}
                        title={GROUP_LABEL[g.group] || g.label}
                        tags={g.tags}
                        selected={tags}
                        onToggle={toggleTag}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {tags.length > 0 && (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => patchParams({ tags: null })}
                  className="text-xs text-muted hover:text-content underline"
                >
                  清除全部标签
                </button>
              </div>
            )}

            <MangaGrid
              items={items}
              total={total}
              hasMore={hasMore}
              isPending={isPending}
              isError={isError}
              error={error}
              isFetching={isFetchingNextPage}
              onLoadMore={loadMore}
              onOpen={openManga}
              emptyHint="当前筛选条件下没有漫画，试着减少标签或换一种排序。"
            />
          </>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

/** 一个可切换的筛选按钮 */
function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md border text-xs transition-colors ${
        active
          ? 'bg-accent border-accent text-on-accent'
          : 'bg-chip border-line text-muted hover:text-content hover:border-accent'
      }`}
    >
      {children}
    </button>
  );
}

/** 一整行筛选（全部 + 若干互斥选项） */
function FilterRow({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string | null) => void;
  /** 选项右侧的补充说明 */
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-faint w-8 shrink-0 pt-1.5">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={!value} onClick={() => onChange(null)}>
          全部
        </FilterChip>
        {options.map((o) => (
          <FilterChip
            key={o.key}
            active={value === o.key}
            onClick={() => onChange(value === o.key ? null : o.key)}
          >
            {o.label}
          </FilterChip>
        ))}
        {hint && <span className="text-xs text-faint ml-1">{hint}</span>}
      </div>
    </div>
  );
}

/** 一组标签（多选） */
function TagSection({
  title,
  tags,
  selected,
  onToggle,
}: {
  title: string;
  tags: { id: string; zh: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <p className="text-xs text-faint mb-1.5">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <FilterChip key={t.id} active={selected.includes(t.id)} onClick={() => onToggle(t.id)}>
            {t.zh}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

/** 结果网格（搜索与浏览共用） */
function MangaGrid({
  items,
  total,
  hasMore,
  isPending,
  isError,
  error,
  isFetching,
  onLoadMore,
  onOpen,
  emptyHint,
}: {
  items: MangaItem[];
  total: number;
  hasMore: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  onLoadMore: () => void;
  onOpen: (id: string) => void;
  emptyHint: string;
}) {
  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-16 text-sm text-muted">
        加载失败：{error?.message || '请稍后重试'}
      </div>
    );
  }

  if (items.length === 0) {
    return <div className="text-center py-16 text-sm text-muted">{emptyHint}</div>;
  }

  return (
    <>
      <div className="mb-3">
        <p className="text-xs text-faint">
          共 {total} 部{total > items.length ? `，已显示 ${items.length}` : ''}
        </p>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
        {items.map((m) => (
          <MangaCard key={m.id} manga={m} onClick={() => onOpen(m.id)} />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            type="button"
            className="btn-primary px-5 py-2 rounded-lg text-sm"
            disabled={isFetching}
            onClick={onLoadMore}
          >
            {isFetching ? '加载中...' : '加载更多'}
          </button>
        </div>
      )}
    </>
  );
}

/** 漫画卡片 */
function MangaCard({ manga, onClick }: { manga: MangaItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  return (
    <button type="button" onClick={onClick} className="text-left group">
      <div className="relative aspect-[3/4] rounded-lg overflow-hidden bg-chip border border-line">
        {manga.cover ? (
          <SmartImage
            url={manga.cover}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={manga.title}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-faint text-xs">无封面</div>
        )}
        {/* MangaDex 用 completed，再漫画直接给中文「已完结」 */}
        {(manga.status === 'completed' || manga.status === '已完结') && (
          <span className="absolute left-1 top-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white">
            完结
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-content line-clamp-2 leading-snug">{manga.title}</p>
      {manga.year && <p className="text-[11px] text-faint mt-0.5">{manga.year}</p>}
    </button>
  );
}

export default function MangaPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      }
    >
      <MangaRoute />
    </Suspense>
  );
}

/**
 * 按查询参数分发：
 * - `?id=xxx` → 漫画详情
 * - 其余（`?q=xxx` 或无参数）→ 分类浏览 / 搜索结果
 *
 * 分发必须在**组件顶层**做，不能塞进 MangaContent 里早退——
 * 否则 MangaContent 的 hooks 会随参数变化而变成条件调用。
 */
function MangaRoute() {
  const searchParams = useSearchParams();
  const id = (searchParams.get('id') || '').trim();
  if (id) return <MangaDetail id={id} />;
  return <MangaContent />;
}

/**
 * 漫画详情。
 *
 * 放在首页同一路径下（`/manga?id=xxx`）而不是独立路由 `/manga/[id]`：
 * 客户端（/app 前缀）下新增一层动态路由要同时改面板转发白名单与
 * Next 路由表，而查询参数不需要——详情、搜索、阅读共用一套前缀逻辑。
 */
function MangaDetail({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = detectBasePath(pathname);
  // 封面图加载方式与全站一致
  const imageMode = useAppStore((s) => s.imageProxyMode);
  const customProxy = useAppStore((s) => s.customImageProxy);
  const searchParams = useSearchParams();
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  // 详情接口按 contentRating 白名单过滤：成人向 / 限制级作品必须显式带档位才取得到，
  // 否则详情 404、章节列表返回 0 条。全站成人过滤开着时一律不放行。
  const ratingRaw = (searchParams.get('rating') || '').trim();
  const rating = !yellowFilter && MANGA_RATINGS.some((r) => r.key === ratingRaw) ? ratingRaw : '';
  const wantAdult = !yellowFilter && (searchParams.get('adult') === '1' || rating !== '');

  const query = useQuery({
    queryKey: ['manga-detail', id, rating, wantAdult],
    queryFn: ({ signal }) =>
      api.mangaDetail(id, { adult: wantAdult, rating: rating || undefined }, signal),
    enabled: id.length > 0,
  });
  const manga = query.data;
  // 详情接口不传 source 时服务端会按 id 形态推断，响应里回传实际用的源
  const detailSource = manga?.source ?? 'mangadex';
  const detailIsZai = detailSource === 'zaimanhua';

  const readFrom = useCallback(
    (chapterId: string) => {
      router.push(
        `${withBasePath('/manga/read', basePath)}?id=${encodeURIComponent(id)}&c=${encodeURIComponent(chapterId)}`
      );
    },
    [router, basePath, id]
  );

  /** 点标签跳到该题材的浏览列表（要带上源，否则 id 会被另一个源的白名单挡掉） */
  const browseTag = useCallback(
    (tagId: string) => {
      router.push(
        `${withBasePath('/manga', basePath)}?source=${detailSource}&tags=${encodeURIComponent(tagId)}${
          rating ? `&rating=${encodeURIComponent(rating)}` : ''
        }`,
        { scroll: false }
      );
    },
    [router, basePath, detailSource, rating]
  );

  if (query.isPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }

  if (query.isError || !manga) {
    return (
      <div className="text-center py-24">
        <p className="text-sm text-muted mb-4">加载失败：{(query.error as Error)?.message || '漫画不存在'}</p>
        <button
          className="btn-primary px-4 py-2 rounded-lg text-sm"
          onClick={() => router.push(withBasePath('/manga', basePath), { scroll: false })}
        >
          返回漫画首页
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col sm:flex-row gap-5">
        {/* 封面 */}
        <div className="w-40 sm:w-52 shrink-0 mx-auto sm:mx-0">
          <div className="aspect-[3/4] rounded-lg overflow-hidden bg-chip border border-line">
            {manga.cover ? (
              <SmartImage url={manga.cover} mode={imageMode} customProxy={customProxy} alt={manga.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-faint text-xs">无封面</div>
            )}
          </div>
        </div>

        {/* 信息 */}
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-content">{manga.title}</h1>

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-faint">
            {manga.year && <span>年份：{manga.year}</span>}
            {/* 再漫画没有「原作语言」字段（地区要按 zone 筛才知道），不展示以免误导 */}
            {!detailIsZai && manga.originalLanguage && (
              <span>原作：{originText(manga.originalLanguage)}</span>
            )}
            {manga.status && <span>状态：{statusText(manga.status)}</span>}
            {manga.chapterCount != null && <span>章节：{manga.chapterCount}</span>}
            {manga.chapterLanguage && <span>语言：{langText(manga.chapterLanguage)}</span>}
            {manga.authors && manga.authors.length > 0 && (
              <span>作者：{manga.authors.slice(0, 3).join('、')}</span>
            )}
          </div>

          {manga.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {manga.tags.slice(0, 12).map((t) => {
                // 内容警示与未成年性化题材不提供「查看更多同类」入口
                const clickable = !EXCLUDED_TAGS.has(t.name);
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={!clickable}
                    onClick={() => browseTag(t.id)}
                    className={`px-2 py-0.5 rounded bg-chip border border-line text-[11px] text-muted ${
                      clickable ? 'hover:text-content hover:border-accent' : 'cursor-default opacity-70'
                    }`}
                    title={clickable ? `浏览更多「${tagLabel(t.name, t.group)}」` : undefined}
                  >
                    {tagLabel(t.name, t.group)}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-40"
              disabled={!manga.chapters?.length}
              onClick={() => readFrom(manga.chapters[0].id)}
            >
              {manga.chapters?.length ? `开始阅读（第 1 话 / 共 ${manga.chapters.length} 话）` : '暂无章节'}
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-chip border border-line text-sm text-muted hover:text-content"
              onClick={() =>
                router.push(
                  `${withBasePath('/manga', basePath)}?source=${detailSource}${
                    rating ? `&rating=${encodeURIComponent(rating)}` : ''
                  }`,
                  { scroll: false }
                )
              }
            >
              返回
            </button>
          </div>

          {manga.description && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-content mb-1.5">简介</p>
              <p className="text-xs text-muted leading-relaxed whitespace-pre-wrap line-clamp-6">
                {manga.description}
              </p>
            </div>
          )}

          {manga.altTitles.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-content mb-1.5">别名</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {manga.altTitles.slice(0, 8).map((a, i) => (
                  <span key={i} className="text-[11px] text-faint">{a}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 章节目录 */}
      {manga.chapters?.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-semibold text-content mb-2">章节目录</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
            {manga.chapters.slice(0, 30).map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => readFrom(c.id)}
                className="px-2 py-1.5 rounded-md border border-line text-xs text-muted hover:text-content hover:border-accent text-left truncate transition-colors"
              >
                {c.number ? `第 ${c.number} 话` : `#${i + 1}`}
                {c.title ? ` ${c.title}` : ''}
              </button>
            ))}
          </div>
          {manga.chapters.length > 30 && (
            <p className="text-[11px] text-faint mt-2">仅显示前 30 话，进入阅读器后可查看完整目录</p>
          )}
        </div>
      )}
    </>
  );
}

function statusText(s: string): string {
  return { ongoing: '连载中', completed: '已完结', hiatus: '休刊', cancelled: '已取消' }[s] || s;
}

function langText(l: string): string {
  return { zh: '中文', 'zh-hk': '繁体', en: '英文', ja: '日文', ko: '韩文' }[l] || l;
}

/** 原作语言 → 来源地（韩国漫画显示为「韩漫」） */
function originText(l: string): string {
  return { ja: '日漫', ko: '韩漫', zh: '国漫', en: '欧美' }[l] || langText(l);
}
