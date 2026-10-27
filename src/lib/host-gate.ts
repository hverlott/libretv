/**
 * 全局按 host 限并发（模块级闸门，跨请求共享）。
 *
 * 使用场景：服务端代替用户向采集站发探测类请求（直播测活 / 画质探测）。
 * 同一运营商的几十个条目常共用一个 host，若只限单请求内的并发，
 * 「多用户 × 单请求并发」会叠加冲击同一弱源，被源站打挂甚至封掉本服务 IP。
 * 同一 host 最多 PER_HOST_CONCURRENCY 个在途请求，不同 host 互不影响；
 * 名额满时 FIFO 排队，空闲闸门及时清理避免 Map 无界增长。
 */

/** 同一 host 允许的最大在途请求数（完整探测：追到分片，压力大，必须严格限流） */
const PER_HOST_CONCURRENCY = 3;

/**
 * 快速探测的同 host 上限：只做一次入口 GET 拿响应头就断开，负载极轻。
 *
 * 为什么需要单独放宽：实测一批 IPTV 订阅里有个别源（如 219.159.147.195:9901，26 个频道）
 * 全部要等满 10 秒才超时，严格限流下这 26 个频道串起来要 90 秒，
 * 而它们本来就是死的——串行等再久也不会活。放宽后整批检测从 57 秒降到十几秒。
 */
export const PER_HOST_CONCURRENCY_FAST = 12;

const hostGates = new Map<string, { active: number; waiters: (() => void)[] }>();

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 取一个该 host 的在途名额，返回释放函数；名额满时排队等待 */
export function acquireHostSlot(host: string, limit = PER_HOST_CONCURRENCY): Promise<() => void> {
  let gate = hostGates.get(host);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    hostGates.set(host, gate);
  }
  const g = gate;
  return new Promise((resolve) => {
    const take = () => {
      g.active++;
      resolve(() => {
        g.active--;
        // 唤醒的等待者同步接管名额（active-- 后立即 ++），不留被新请求插队的竞态窗口
        const next = g.waiters.shift();
        if (next) next();
        else if (g.active === 0) hostGates.delete(host);
      });
    };
    if (g.active < limit) take();
    else g.waiters.push(take);
  });
}

/**
 * 在 host 闸门内执行 fn：排队等待的时间不占用 fn 内部的超时预算（超时在 fn 内自行起算）。
 *
 * limit：同 host 的在途上限。快速探测传 FAST 上限，完整探测用默认的严格上限。
 */
export async function withHostLimit<T>(
  url: string,
  fn: () => Promise<T>,
  limit = PER_HOST_CONCURRENCY
): Promise<T> {
  const release = await acquireHostSlot(hostOf(url), limit);
  try {
    return await fn();
  } finally {
    release();
  }
}
