/**
 * 令牌与 PIN 的生成/哈希。使用 Workers 内建 Web Crypto。
 *
 * 原则：明文令牌只在签发那一刻存在于响应里，服务端只落哈希。
 * PIN 每席位独立 salt，避免同 PIN 产生相同哈希。
 */

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 字节随机令牌，base64url 编码 */
export function newSeatToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toBase64Url(b);
}

export function newSalt(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toBase64Url(b);
}

export function newId(prefix: string): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return prefix + "_" + toBase64Url(b);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export const hashToken = (token: string) => sha256Hex("tok:" + token);
export const hashPin = (pin: string, salt: string) => sha256Hex("pin:" + salt + ":" + pin);

/** 定时安全比较，避免哈希比对被计时侧信道利用 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
