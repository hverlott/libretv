/**
 * 本地加密的**客户端**部分（浏览器环境）。
 *
 * 与 `privacy-crypto-server.ts` 分开的原因：
 * 本文件会被打包进客户端 bundle，不能 import `node:crypto`——
 * 那样 webpack 会报 `UnhandledSchemeError: Reading from "node:crypto"`。
 * 服务端专用的密钥派生放在同目录的 privacy-crypto-server.ts。
 *
 * 加密方案（与文档 PRIVACY.md 一致）：
 * - 主密钥由服务端派生，经鉴权接口下发，**只在内存中持有**；
 * - HKDF 拆出两个子密钥：AES-256-GCM（加密）与 HMAC-SHA256（盲索引）；
 * - AES-GCM 自带完整性校验，密文被篡改会解密失败而非静默返回垃圾。
 */

/** 加密数据前缀：用于识别密文与明文，兼作版本标记 */
export const ENC_PREFIX = 'enc1:';
/** 盲索引前缀：标识主键是 HMAC 值而非明文 */
export const BLIND_PREFIX = 'bidx1:';

/** HKDF 用途标签（与服务端派生保持一致） */
const INFO_ENCRYPT = 'libretv:history:encrypt:v1';
const INFO_INDEX = 'libretv:history:index:v1';
/** HKDF salt（与服务端派生保持一致） */
const HKDF_SALT = 'libretv:privacy:v1';

/** 客户端持有的子密钥（仅内存，不落盘） */
interface ClientKeys {
  enc: CryptoKey;
  index: CryptoKey;
}

let clientKeys: ClientKeys | null = null;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** 是否是加密后的值 */
export function isEncrypted(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** 是否是盲索引主键 */
export function isBlindIndex(value: string): boolean {
  return value.startsWith(BLIND_PREFIX);
}

/** 是否已注入密钥 */
export function hasEncryptionKey(): boolean {
  return clientKeys !== null;
}

/**
 * 注入主密钥（base64），派生出子密钥。
 *
 * 只在内存中保存；页面刷新后需重新从服务端获取（由 /api/privacy/key 提供）。
 */
export async function initEncryptionKey(masterBase64Value: string): Promise<void> {
  const master = base64ToBytes(masterBase64Value);
  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const salt = new TextEncoder().encode(HKDF_SALT);
  const encBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(INFO_ENCRYPT) },
      hkdfKey,
      256
    )
  );
  const indexBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(INFO_INDEX) },
      hkdfKey,
      256
    )
  );
  clientKeys = {
    enc: await crypto.subtle.importKey('raw', encBytes, 'AES-GCM', false, ['encrypt', 'decrypt']),
    index: await crypto.subtle.importKey('raw', indexBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}

/** 清除内存中的密钥（退出登录时调用） */
export function clearEncryptionKey(): void {
  clientKeys = null;
}

/**
 * 加密一段文本。
 *
 * 格式：`enc1:<base64(iv)>:<base64(ciphertext)>`。
 * 未初始化密钥时返回原文（调用方据此判断是否需要落密文）。
 */
export async function encryptText(plain: string): Promise<string> {
  if (!clientKeys) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clientKeys.enc, data)
  );
  return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(cipher)}`;
}

/**
 * 解密一段文本。
 *
 * 无密钥或解密失败时返回 null——由调用方决定是回退明文还是提示。
 */
export async function decryptText(value: string): Promise<string | null> {
  if (!clientKeys) return null;
  if (!isEncrypted(value)) return value;
  const body = value.slice(ENC_PREFIX.length);
  const sep = body.indexOf(':');
  if (sep <= 0) return null;
  try {
    const iv = base64ToBytes(body.slice(0, sep));
    const cipher = base64ToBytes(body.slice(sep + 1));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, clientKeys.enc, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * 计算盲索引（搜索历史主键）。
 *
 * 未初始化密钥时退回明文（此时仍可用，只是失去盲索引保护）。
 */
export async function blindIndex(plain: string): Promise<string> {
  if (!clientKeys) return plain;
  const sig = await crypto.subtle.sign('HMAC', clientKeys.index, new TextEncoder().encode(plain));
  return `${BLIND_PREFIX}${bytesToBase64(new Uint8Array(sig))}`;
}

/** 主密钥是否可用（供 UI 判断能否展示密文内容） */
export function encryptionReady(): boolean {
  return clientKeys !== null;
}
