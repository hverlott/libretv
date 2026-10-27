import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { deriveMasterKey, encodeMasterKey } from '@/lib/privacy-crypto-server';

export const runtime = 'nodejs';

/**
 * 下发本地加密主密钥（仅供已登录会话）。
 *
 * 密钥由服务端部署密钥派生（PROXY_SECRET，未配置时由 PASSWORD 派生），
 * **不会**下发原始部署密钥本身，客户端拿到的只是一个用途受限的派生值。
 *
 * 客户端只在内存中持有它（不写 localStorage / IndexedDB），
 * 因此「只有磁盘文件」的泄露场景无法解密观看历史。
 *
 * 需要鉴权：未登录的请求拿不到密钥，也就无法解密磁盘上的密文。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const secret = process.env.PROXY_SECRET || process.env.PASSWORD || '';
  if (!secret) {
    // 未配置密码时全站无鉴权，密钥就等于公开——此时明文历史反而更安全可读
    return NextResponse.json({ available: false, key: null });
  }

  const master = deriveMasterKey(secret);
  return NextResponse.json(
    { available: true, key: encodeMasterKey(master) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
