'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { LIVE_PROBE_TTL_MS, useAppStore, type LiveProbeEntry } from '@/lib/store';

/**
 * 直播频道批量测活 hook：
 * - 结果持久化到 store（liveProbeResults），6 小时内直接复用（LIVE_PROBE_TTL_MS）；
 * - 触发探测时只补测缺失或已过期的频道，全部仍有效则提示跳过；
 * - 服务端以 NDJSON 流式逐条返回，结果边测边写入列表（节流合并，避免高频 re-render）；
 * - 每批 CHUNK_SIZE 条并行 CHUNK_CONCURRENCY 批，服务端批内并发 16、单 host 在途 ≤3（按源排队，不冲垮弱源）；
 * - 目标数无上限（仅 MAX_TARGETS 保险阀防病态列表）：几千频道自动分批排队跑完，
 *   进度带 ETA，可随时取消（保留已完成的结果）；
 * - 重新测活/清空时 abort 在途请求并作废上一轮（runId 比对）。
 */

export interface ProbeResult {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  codec?: string;
  /** 因超时失败（源可能只是慢） */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps），低于阈值为「源限速」 */
  kbps?: number;
}

const CHUNK_SIZE = 50;
/** 同时在途的批次数：与 CHUNK_SIZE 相乘即最大并发探测规模 */
const CHUNK_CONCURRENCY = 2;
/**
 * 快速模式的批并发：只做入口级 GET，负载轻，可以铺得更快。
 * 与服务端「快速模式同 host 上限 12」配合，显著缩短全量体检的等待时间。
 */
const FAST_CHUNK_CONCURRENCY = 5;
/**
 * 单轮测活目标数上限（保险阀）：正常几千个频道分批排队都能跑完，不设人为瓶颈；
 * 只防病态超大列表（如数十万行的脏 M3U）拖死浏览器与服务端，超出部分提示后丢弃。
 */
const MAX_TARGETS = 20_000;
/** 流式结果的写回节流间隔：把高频到达的结果合并成一次 store 更新 */
const FLUSH_INTERVAL_MS = 200;

/**
 * 模块级的运行状态：让「直播体检」与「频道侧栏」两个 hook 实例共享同一轮探测。
 *
 * 提到模块级而不是各自 useRef 的原因：两个组件同时挂载时，
 * 各自一份 abortController 会导致「取消」只中止自己发起的那一轮，
 * 另一轮继续在跑并写回结果；各自一份 runId 也没法互相作废。
 */
let sharedAbort: AbortController | null = null;
/** 当前运行轮次号：每次发起新探测自增，用于作废上一轮的结果写回 */
let sharedRunId = 0;
/** 正在运行的 promise：用于「已在检测中」判定，避免重复发起 */
let runningProbe: Promise<void> | null = null;

export function useLiveProbe() {
  const cache = useAppStore((s) => s.liveProbeResults);
  // 进度状态放在 store：直播页有「体检面板」和「频道侧栏」两个消费者，
  // 各自持局部状态会出现进度不同步、两边都显示「未在检测」。
  const progress = useAppStore((s) => s.liveProbeProgress);
  const setProgress = useAppStore((s) => s.setLiveProbeProgress);
  const [hint, setHint] = useState('');
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 3000);
  }, []);

  useEffect(() => () => {
    // 卸载时只清理本实例的提示计时，不中止共享探测——
    // 探测属于整页共享资源，另一个消费者可能仍在显示它的进度
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);

  // 仅暴露 6 小时内的结果，过期条目对 UI 不可见。
  // 结果对象按 (url, timestamp) 复用身份：节流写回只更新被探测到的频道，
  // 未变化的条目保持同一对象引用，下游 memo 行组件才能精确跳过重渲染。
  const identityRef = useRef(new Map<string, { timestamp: number; result: ProbeResult }>());
  const results = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ProbeResult>();
    const identities = identityRef.current;
    for (const [url, e] of Object.entries(cache)) {
      if (now - e.timestamp >= LIVE_PROBE_TTL_MS) continue;
      const known = identities.get(url);
      const result =
        known && known.timestamp === e.timestamp
          ? known.result
          : {
              ok: e.ok,
              ms: e.ms,
              level: e.level,
              error: e.error,
              codec: e.codec,
              timedOut: e.timedOut,
              kbps: e.kbps,
            };
      if (!known || known.timestamp !== e.timestamp) identities.set(url, { timestamp: e.timestamp, result });
      map.set(url, result);
    }
    // 清理已过期频道的身份缓存，避免无界增长
    if (identities.size > map.size) {
      for (const url of identities.keys()) {
        if (!map.has(url)) identities.delete(url);
      }
    }
    return map;
  }, [cache]);

  const clear = useCallback(() => {
    sharedRunId++;
    sharedAbort?.abort();
    sharedAbort = null;
    runningProbe = null;
    useAppStore.getState().clearLiveProbeResults();
    setProgress(null);
  }, [setProgress]);

  /** 中止在途测活：已完成的结果保留，未完成的频道保持待测状态（下次测活会补上） */
  const cancel = useCallback(() => {
    if (!sharedAbort) return;
    sharedRunId++;
    sharedAbort.abort();
    sharedAbort = null;
    runningProbe = null;
    setProgress(null);
  }, [setProgress]);

  const probe = useCallback(
    async (targets: { url: string }[], opts?: { force?: boolean; fast?: boolean }) => {
      const allUrls = [...new Set(targets.map((t) => t.url))];
      if (allUrls.length === 0) return;
      // 已在检测中：不再重复发起（两个消费者共用同一轮）
      if (runningProbe) {
        showHint('检测进行中，请等待完成');
        return runningProbe;
      }
      if (allUrls.length > MAX_TARGETS) {
        showHint(`频道数超过 ${MAX_TARGETS}，仅测前 ${MAX_TARGETS} 个，请精简订阅源`);
      }
      const urls = allUrls.slice(0, MAX_TARGETS);
      // fast：只做入口级探测，几十倍快，用于全量体检快速筛死台
      const fast = opts?.fast === true;

      // 6 小时内已测过的直接复用，仅补测缺失或过期的频道。
      // force=true 时无视缓存全量重测——「一键体检」需要反映当下真实状态。
      const now = Date.now();
      const cached = useAppStore.getState().liveProbeResults;
      const stale = urls.filter((u) => {
        if (opts?.force) return true;
        const e = cached[u];
        return !e || now - e.timestamp >= LIVE_PROBE_TTL_MS;
      });
      if (stale.length === 0) {
        showHint('测活结果 6 小时内有效，无需重测');
        return;
      }

      const runId = ++sharedRunId;
      // 作废上一轮的在途请求，避免切换筛选/重复点击后旧结果继续写回
      sharedAbort?.abort();
      const controller = new AbortController();
      sharedAbort = controller;

      const chunks: string[][] = [];
      for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
        chunks.push(stale.slice(i, i + CHUNK_SIZE));
      }
      // startedAt 供 UI 按已完成均速估算剩余时间
      const startedAt = Date.now();
      setProgress({ done: 0, total: stale.length, startedAt });

      let done = 0;
      let buffer: Record<string, LiveProbeEntry> = {};
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (sharedRunId !== runId) return;
        if (Object.keys(buffer).length > 0) {
          const entries = buffer;
          buffer = {};
          useAppStore.getState().setLiveProbeResults(entries);
        }
        setProgress({ done: Math.min(done, stale.length), total: stale.length, startedAt });
      };
      const scheduleFlush = () => {
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      };

      let nextChunk = 0;
      const worker = async () => {
        for (;;) {
          if (sharedRunId !== runId) return;
          const index = nextChunk++;
          if (index >= chunks.length) return;
          const chunk = chunks[index];
          const received = new Set<string>();
          try {
            await api.liveProbeStream(
              chunk,
              (r) => {
                received.add(r.url);
                if (sharedRunId !== runId) return;
                buffer[r.url] = {
                  ok: r.ok,
                  ms: r.ms,
                  level: r.level,
                  error: r.error,
                  codec: r.codec,
                  timedOut: r.timedOut,
                  kbps: r.kbps,
                  timestamp: Date.now(),
                };
                done++;
                scheduleFlush();
              },
              controller.signal,
              fast
            );
          } catch {
            // 整批失败/被取消：不写缓存，保持待测状态以便下次重试
          }
          // 流中途断开时未返回的目标：只补进度，不写缓存
          done += chunk.length - received.size;
          flush();
        }
      };

      const task = (async () => {
        // 快速模式的批并发更高：只做入口级请求，负载轻，可以更快铺开；
        // 完整模式保持默认（追分片压力大，客户端与服务端都不宜过量并发）
        const concurrency = fast ? FAST_CHUNK_CONCURRENCY : CHUNK_CONCURRENCY;
        await Promise.all(
          Array.from({ length: Math.min(concurrency, chunks.length) }, worker)
        );

        if (flushTimer) clearTimeout(flushTimer);
        if (sharedRunId !== runId) return;
        flush();
        setProgress(null);
        if (sharedAbort === controller) sharedAbort = null;
      })();

      runningProbe = task;
      try {
        await task;
      } finally {
        if (runningProbe === task) runningProbe = null;
      }
    },
    [showHint, setProgress]
  );

  return { results, progress, probe, cancel, clear, isProbing: progress !== null, hint };
}
