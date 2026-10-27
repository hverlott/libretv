'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import { isSlowSource } from '@/lib/live-channel-filter';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { LiveChannelItem } from './live-channel-list';

/**
 * 直播体检：一键检测所有频道能否正常连接。
 *
 * 与侧栏「测活」的区别：
 * - 侧栏测的是**当前筛选后**的列表（可能只有几十个）；
 * - 这里测的是**全部已启用源的所有频道**，并给出汇总统计——
 *   多少可播、多少失效、多少超时、哪个源全挂。
 *
 * 检测口径与侧栏一致（分片级校验 + 吞吐采样），结果共享同一份缓存，
 * 因此体检完侧栏的状态点也会同步亮起。
 */

export interface LiveCheckSummary {
  total: number;
  /** 分片级验证通过且带宽正常 */
  green: number;
  /** 可播但只是弱验证（直链/清单级） */
  weak: number;
  /** 分片可达但带宽不足（会卡） */
  slow: number;
  /** 明确失败 */
  failed: number;
  /** 超时（源可能只是慢） */
  timedOut: number;
  /** 还没测到 */
  untested: number;
}

export function summarizeProbe(
  channels: { url: string }[],
  results: Map<string, ProbeResult>
): LiveCheckSummary {
  const s: LiveCheckSummary = {
    total: channels.length,
    green: 0,
    weak: 0,
    slow: 0,
    failed: 0,
    timedOut: 0,
    untested: 0,
  };
  for (const c of channels) {
    const p = results.get(c.url);
    if (!p) {
      s.untested++;
      continue;
    }
    if (!p.ok) {
      if (p.timedOut) s.timedOut++;
      else s.failed++;
      continue;
    }
    if (p.level !== 'segment') s.weak++;
    else if (isSlowSource(p)) s.slow++;
    else s.green++;
  }
  return s;
}

interface LiveHealthPanelProps {
  /** 全部频道（已去重、已跨源合并） */
  channels: LiveChannelItem[];
  /** 订阅源地址 → 显示名，用于按源统计 */
  sourceLabels?: Map<string, string>;
}

export function LiveHealthPanel({ channels, sourceLabels }: LiveHealthPanelProps) {
  const {
    results,
    progress,
    probe,
    cancel,
    clear,
    isProbing,
    hint,
  } = useLiveProbe();

  const [expanded, setExpanded] = useState(false);
  /**
   * 检测模式：
   * - fast（默认）：只做入口级探测，几十秒出结果，足以筛出大批死台；
   * - full：追到分片并采样带宽，精确但慢（几百个频道要好几分钟）。
   */
  const [fast, setFast] = useState(true);
  /** 只看可播的频道（体检后一键过滤失效台）——与频道列表共享 */
  const hideBroken = useAppStore((s) => s.hideBrokenLiveChannels);
  const setHideBroken = useAppStore((s) => s.setHideBrokenLiveChannels);

  const summary = useMemo(
    () => summarizeProbe(channels, results),
    [channels, results]
  );

  // 探测中每秒刷新一次，驱动进度文案里的 ETA 走动
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isProbing) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isProbing]);

  // 按源统计：哪个订阅整体不可用
  const bySource = useMemo(() => {
    const map = new Map<string, { total: number; ok: number }>();
    for (const c of channels) {
      const key = c.sourceUrl || '未知来源';
      const entry = map.get(key) ?? { total: 0, ok: 0 };
      entry.total++;
      if (results.get(c.url)?.ok) entry.ok++;
      map.set(key, entry);
    }
    return [...map.entries()]
      .map(([url, v]) => ({ url, name: sourceLabels?.get(url) ?? url, ...v }))
      .sort((a, b) => a.ok / Math.max(a.total, 1) - b.ok / Math.max(b.total, 1));
  }, [channels, results, sourceLabels]);

  const testedCount = summary.total - summary.untested;
  const hasResults = testedCount > 0;

  /** 一键体检：全量重测所有频道 */
  const runFullCheck = () => {
    void probe(channels, { force: true, fast });
  };

  return (
    <section className="bg-surface-raised border border-line rounded-lg p-3 mt-3">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <h2 className="text-sm font-semibold text-content">直播体检</h2>
        <div className="flex items-center gap-1.5">
          {isProbing ? (
            <button className="btn-ghost btn-sm" onClick={cancel} title="中止检测，已完成的结果会保留">
              取消检测
            </button>
          ) : (
            <>
              {/* 检测模式：快速只验入口（快），完整追到分片（准但慢） */}
              <div className="flex bg-chip rounded-md p-0.5">
                <ModeButton active={fast} onClick={() => setFast(true)} title="只验证频道入口是否可达，速度快，适合快速筛出失效台">
                  快速
                </ModeButton>
                <ModeButton active={!fast} onClick={() => setFast(false)} title="追到分片并采样带宽，最准确但耗时较长">
                  精确
                </ModeButton>
              </div>
              <button
                className="btn-primary btn-sm"
                onClick={runFullCheck}
                disabled={channels.length === 0}
                title={`一次性检测全部 ${channels.length} 个频道能否正常连接（${fast ? '快速模式：只验入口' : '精确模式：追到分片并测速'}）`}
              >
                一键检测全部
              </button>
            </>
          )}
        </div>
      </div>

      {channels.length === 0 ? (
        <p className="text-xs text-faint">暂无可检测的频道</p>
      ) : (
        <>
          {/* 汇总统计 */}
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            <StatChip label="频道" value={summary.total} tone="neutral" />
            {summary.green > 0 && <StatChip label="正常" value={summary.green} tone="ok" />}
            {summary.weak > 0 && <StatChip label="弱验证" value={summary.weak} tone="weak" />}
            {summary.slow > 0 && <StatChip label="限速" value={summary.slow} tone="slow" />}
            {summary.failed > 0 && <StatChip label="失效" value={summary.failed} tone="bad" />}
            {summary.timedOut > 0 && <StatChip label="超时" value={summary.timedOut} tone="warn" />}
            {summary.untested > 0 && (
              <StatChip label="未测" value={summary.untested} tone="neutral" />
            )}
          </div>

          {/* 进度 */}
          {isProbing && progress && (
            <div className="mb-2.5">
              <div className="flex items-center justify-between text-[11px] text-faint mb-1">
                <span>
                  检测中 {progress.done}/{progress.total}
                  {progress.total > 0 && ` · ${Math.round((progress.done / progress.total) * 100)}%`}
                </span>
                <span>{formatEta(progress)}</span>
              </div>
              <div className="h-1 bg-chip rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-300"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {hint && <p className="text-[11px] text-faint mb-2">{hint}</p>}

          {/* 操作行 */}
          {hasResults && !isProbing && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                className={cn(
                  'px-2 py-0.5 rounded-full text-[11px] transition-colors border',
                  hideBroken
                    ? 'bg-accent text-on-accent border-accent'
                    : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
                )}
                onClick={() => setHideBroken(!hideBroken)}
                title="在频道列表中隐藏检测为失效/超时的频道"
              >
                {hideBroken ? '已隐藏失效台' : '隐藏失效台'}
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  clear();
                  setHideBroken(false);
                }}
                title="清除全部检测结果"
              >
                清除结果
              </button>
              <button
                className="text-[11px] text-faint hover:text-content"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? '收起按源统计' : '按源统计'}
              </button>
            </div>
          )}

          {/* 按源统计 */}
          {expanded && bySource.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-line space-y-1">
              {bySource.map((s) => {
                const pct = Math.round((s.ok / Math.max(s.total, 1)) * 100);
                return (
                  <div key={s.url} className="flex items-center gap-2 text-[11px]">
                    <span className="truncate text-muted w-28 shrink-0" title={s.name}>
                      {s.name}
                    </span>
                    <div className="flex-1 h-1 bg-chip rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full',
                          pct >= 80 ? 'bg-success' : pct >= 30 ? 'bg-warning' : 'bg-danger'
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-faint shrink-0 tabular-nums">
                      {s.ok}/{s.total}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 进度 ETA：按已完成均速估算剩余时间 */
function formatEta(p: { done: number; total: number; startedAt: number }): string {
  const remaining = p.total - p.done;
  if (remaining <= 0) return '';
  if (p.done <= 0) return '估算中…';
  const perMs = (Date.now() - p.startedAt) / p.done;
  const sec = Math.ceil((perMs * remaining) / 1000);
  if (sec < 60) return `预计剩余 ${sec} 秒`;
  return `预计剩余 ${Math.ceil(sec / 60)} 分钟`;
}

/** 模式切换按钮（快速 / 精确） */
function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        'px-2 py-0.5 rounded text-[11px] transition-colors',
        active ? 'bg-accent text-on-accent font-medium' : 'text-muted hover:text-content'
      )}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function StatChip({  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'ok' | 'weak' | 'slow' | 'bad' | 'warn';
}) {
  const toneClass = {
    neutral: 'bg-chip text-faint border-line',
    ok: 'bg-success/10 text-success border-success/30',
    weak: 'bg-chip text-muted border-line',
    slow: 'bg-warning/10 text-warning border-warning/30',
    bad: 'bg-danger/10 text-danger border-danger/30',
    warn: 'bg-warning/10 text-warning border-warning/30',
  }[tone];
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-[11px] border', toneClass)}>
      {label} {value}
    </span>
  );
}
