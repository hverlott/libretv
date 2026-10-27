/**
 * 本地加密的**服务端**部分（Node 运行时）。
 *
 * 与 `privacy-crypto.ts`（客户端）分文件的原因：
 * 客户端 bundle 不能包含 `node:crypto`（webpack 会报 UnhandledSchemeError）。
 * 这里只放服务端需要的密钥派生，客户端永远拿不到部署密钥本身。
 */

import { hkdfSync } from 'node:crypto';

/** HKDF 用途标签（必须与客户端 privacy-crypto.ts 保持一致） */
const INFO_ENCRYPT = 'libretv:history:encrypt:v1';
/** HKDF salt（必须与客户端 privacy-crypto.ts 保持一致） */
const HKDF_SALT = 'libretv:privacy:v1';

/**
 * 由部署密钥派生主密钥。
 *
 * 部署密钥优先取 `PROXY_SECRET`；未配置时用 `PASSWORD` 派生
 * （与 auth.ts 的会话密钥同一来源，保证单配置即可自洽）。
 *
 * 派生用 HKDF-SHA256：固定 salt + 用途标签，
 * 得到 32 字节主密钥后由客户端再拆成加密/盲索引两个子密钥。
 */
export function deriveMasterKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), INFO_ENCRYPT, 32)
  );
}

/** 把主密钥编码为 base64（供 HTTP 下发） */
export function encodeMasterKey(master: Buffer): string {
  return master.toString('base64');
}
