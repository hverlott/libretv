import { fetchUpstream } from '../fetch-utils';

/**
 * 评分站请求出口。
 *
 * 生产路径走 fetchUpstream（超时 + 安全跳转 + SSRF 校验）；
 * 测试路径由 __setFetcher 注入，避免单测真的去做 DNS 解析与联网。
 * 与 doh.ts 的 systemResolver 注入是同一套路：ESM 命名空间 spy 无效，只能留可注入点。
 */

let injected: typeof fetch | null = null;

export function __setFetcher(fn: typeof fetch | null): void {
  injected = fn;
}

export async function requestUpstream(
  url: string,
  options: { timeoutMs: number; headers?: Record<string, string> }
): Promise<Response> {
  if (injected) return injected(url, { headers: options.headers });
  return fetchUpstream(url, { timeoutMs: options.timeoutMs, headers: options.headers });
}
