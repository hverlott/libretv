/**
 * 站内导航记录：给「返回上一级」提供真实依据。
 *
 * ## 为什么不能靠 document.referrer / router.back()
 *
 * 桌面客户端用的是浏览器 app 模式（无地址栏、无后退按钮），所以**站点必须自带返回**。
 * 但原来的实现有两个坑：
 *
 * 1. `document.referrer` 只在**文档加载**时写入，Next.js 的客户端路由跳转不会更新它。
 *    于是「搜索结果 → 播放页」这种站内跳转，referrer 仍是打开首页时的旧值，
 *    `internal` 判断永远为 false，返回按钮直接 push('/') —— 搜索词丢了，
 *    用户体感就是「回不到上一级」。
 * 2. `router.back()` 在客户端里可能退回控制面板（面板页在同一个历史栈里），
 *    表现为「点了返回跳出了 LibreTV」。
 *
 * 这里自己维护一个栈：只记录**本站页面**的 pathname + query，
 * 面板页永远不会进来，所以返回一定落在站内。
 *
 * 只记 pathname + search，**不记 hash**：播放页的片名/sourceUrl 都在片段里，
 * 那是隐私设计的一部分，不该被抄进导航记录。
 */

const STORAGE_KEY = 'libretv:nav:stack';
/** 只保留最近 20 条：够覆盖「首页 → 分类 → 详情 → 播放」这类深度，也不会无限增长 */
const MAX_DEPTH = 20;

function readStack(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function writeStack(stack: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    // 隐私模式 / 配额用尽：退化为「只能回首页」，不影响功能
  }
}

/**
 * 下一次记录是「原地替换」而不是「新开一页」。
 *
 * 切集、翻章、切直播分类用的都是 router.replace——URL 变了但用户还在同一页，
 * 不标记的话返回键会退到「上一集」，读过 20 章就要按 20 次才能出去。
 * 带 1 秒有效期：万一 replace 到相同 URL（React 不触发变更）不会误伤后续的正常跳转。
 */
let replaceUntil = 0;

export function markRecordReplace(): void {
  replaceUntil = Date.now() + 1000;
}

/** 记录一次访问（同一页连续记录只留一条） */
export function recordVisit(path: string): void {
  if (!path) return;
  const stack = readStack();

  if (Date.now() < replaceUntil && stack.length > 0) {
    replaceUntil = 0;
    stack[stack.length - 1] = path;
    writeStack(stack);
    return;
  }

  if (stack[stack.length - 1] === path) return;
  stack.push(path);
  if (stack.length > MAX_DEPTH) stack.splice(0, stack.length - MAX_DEPTH);
  writeStack(stack);
}

/** 当前页的上一级；没有记录（首次直接打开）时返回 undefined */
export function previousPath(current: string): string | undefined {
  const stack = readStack();
  let index = stack.length - 1;
  while (index >= 0 && stack[index] === current) index--;
  return index >= 0 ? stack[index] : undefined;
}

/**
 * 返回后整理栈：把目标页变成栈顶。
 *
 * 不做这一步的话，A → B → 返回 A 之后栈里还是 [A, B]，
 * 再点返回会又跑到 B，形成来回横跳。
 */
export function truncateTo(target: string): void {
  const stack = readStack();
  const index = stack.lastIndexOf(target);
  if (index >= 0) stack.length = index + 1;
  else stack.push(target);
  writeStack(stack);
}

/** 测试与调试用 */
export function clearNavHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

export const NAV_HISTORY_KEY = STORAGE_KEY;
