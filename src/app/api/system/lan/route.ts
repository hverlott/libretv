import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { getEnvFileValue, setEnvFileValue } from '@/lib/env-file';
import { getLanInfo, resolveBindHost } from '@/lib/lan-access';

export const runtime = 'nodejs';

/**
 * 局域网访问开关：把 `LAN_ACCESS=1/0` 写进 `.env`。
 *
 * 只写文件不重启：重启会让当前请求的响应发不出去（进程被杀）。
 * 前端拿到 `restartRequired: true` 后提示用户点「重启」。
 *
 * 为什么不让前端直接改 `.env`：浏览器没有文件系统权限，
 * 而这个开关必须持久化到部署配置里，不能只存在 localStorage
 * ——否则换台设备打开页面就「看起来又关了」。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as { enabled?: unknown };
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }
  if (typeof body.enabled !== 'boolean') {
    return jsonError('enabled 必须是布尔值', 400);
  }

  try {
    setEnvFileValue('LAN_ACCESS', body.enabled ? '1' : '0');
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '写入 .env 失败', 500);
  }

  // BIND_HOST 显式写了的话优先级高于 LAN_ACCESS，此时开关会被它覆盖——
  // 必须告诉用户，否则「开了没反应」会变成又一个玄学问题
  const bindHostInFile = getEnvFileValue('BIND_HOST');
  const overriddenByBindHost = Boolean(bindHostInFile);

  return NextResponse.json(
    {
      saved: true,
      enabled: body.enabled,
      restartRequired: true,
      overriddenByBindHost,
      bindHost: bindHostInFile ?? null,
      // 当前进程仍是旧配置，重启前别拿它当「已生效」的证据
      current: getLanInfo(Number(process.env.PORT) || 8080),
      bindHostPreview: resolveBindHost({
        ...process.env,
        LAN_ACCESS: body.enabled ? '1' : '0',
        BIND_HOST: bindHostInFile,
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
