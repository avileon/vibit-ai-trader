import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** MASTER_KEY: 32 bytes, base64 (generate: openssl rand -base64 32) */
export function parseMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  return key;
}

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64) */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [v, ivB, tagB, ctB] = payload.split(':');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('Bad secret payload');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB, hashB] = stored.split('$');
  if (alg !== 'scrypt' || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, 'base64');
  const actual = await scryptAsync(pw, Buffer.from(saltB, 'base64'), expected.length, SCRYPT_OPTS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** מסתיר סוד לתצוגה/לוג: "PK…7Q2X" */
export function maskSecret(s: string): string {
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 2)}…${s.slice(-4)}`;
}
