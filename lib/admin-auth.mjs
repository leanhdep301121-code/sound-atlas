import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { redis, jsonResponse } from './live-store.mjs';

const COOKIE = '__Host-sound-atlas-admin';
const SESSION_SECONDS = 8 * 60 * 60;
const SESSION_PREFIX = 'sound-atlas:admin-session:';
const trustedOrigins = new Set(['https://www.alecyin.icu', 'https://sound-atlas-studio.vercel.app']);
const digest = value => createHash('sha256').update(value).digest('hex');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function apiError(error) {
  return jsonResponse({ error: error instanceof HttpError ? error.message : '管理服务暂时不可用，请稍后重试。' }, error instanceof HttpError ? error.status : 503);
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}
export function checkOrigin(request) {
  const origin = request.headers.get('origin');
  const ownOrigin = new URL(request.url).origin;
  if (!origin || !(trustedOrigins.has(origin) || origin === ownOrigin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, '请从声场管理页面提交操作。');
  }
}
function configuredHash() {
  const hash = process.env.SOUND_ATLAS_ADMIN_KEY_HASH;
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new HttpError(503, '管理登录尚未配置。');
  return hash;
}
function sessionToken(request) {
  const entry = (request.headers.get('cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(COOKIE + '='));
  const token = entry?.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token || '') ? token : null;
}
export async function requireAdmin(request, { write = false } = {}) {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, '请先登录数据采集管理。');
  const stored = await redis(['GET', SESSION_PREFIX + digest(token)]);
  let session;
  try { session = stored ? JSON.parse(stored) : null; } catch { session = null; }
  if (!session || session.expiresAt <= Date.now() || session.keyVersion !== configuredHash()) throw new HttpError(401, '登录已过期，请重新输入管理口令。');
  if (write) {
    checkOrigin(request);
    if (!safeEqual(request.headers.get('x-csrf-token'), session.csrf)) throw new HttpError(403, '页面验证已失效，请刷新后重试。');
  }
  return { session, csrf: session.csrf };
}
function cookie(value, age) { return `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`; }

export async function login(request) {
  checkOrigin(request);
  const keyHash = configuredHash();
  if (Number(request.headers.get('content-length')) > 4096) throw new HttpError(400, '口令格式不正确。');
  const bytes = await request.text();
  if (bytes.length > 4096) throw new HttpError(400, '口令格式不正确。');
  let body;
  try { body = JSON.parse(bytes); } catch { throw new HttpError(400, '口令格式不正确。'); }
  const address = (request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].slice(0, 128);
  const rateKey = 'sound-atlas:admin-login:' + digest(address);
  const attempts = Number(await redis(['EVAL', "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],600) end;return n", '1', rateKey]));
  if (attempts > 8) throw new HttpError(429, '登录尝试较多，请十分钟后重试。');
  const supplied = typeof body.key === 'string' ? body.key.trim() : '';
  if (supplied.length < 24 || supplied.length > 256 || !safeEqual(digest(supplied), keyHash)) throw new HttpError(401, '管理口令不正确。');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const session = { id: randomBytes(18).toString('base64url'), csrf, keyVersion: keyHash, createdAt: Date.now(), expiresAt: Date.now() + SESSION_SECONDS * 1000 };
  await redis(['SET', SESSION_PREFIX + digest(token), JSON.stringify(session), 'EX', String(SESSION_SECONDS)]);
  await redis(['DEL', rateKey]);
  const response = jsonResponse({ authenticated: true, csrf });
  response.headers.set('Set-Cookie', cookie(token, SESSION_SECONDS));
  return response;
}
export async function logout(request) {
  await requireAdmin(request, { write: true });
  await redis(['DEL', SESSION_PREFIX + digest(sessionToken(request))]);
  const response = jsonResponse({ authenticated: false });
  response.headers.set('Set-Cookie', cookie('', 0));
  return response;
}
