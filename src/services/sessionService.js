import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import * as redis from './redisService.js';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'omc_sid';
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || `${7 * 24 * 60 * 60}`, 10);

function secret() {
  return process.env.SESSION_SECRET || 'change-me-in-production';
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function verify(value, signature) {
  if (!value || !signature) return false;
  const expected = Buffer.from(sign(value));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookieHeader(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return cookies;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function sessionKey(sessionId) {
  return `session:${sessionId}`;
}

export async function getSessionFromRequest(req) {
  const cookies = req.cookies || parseCookieHeader(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  const [sessionId, signature] = String(raw || '').split('.');

  if (!verify(sessionId, signature)) {
    return { id: randomUUID(), data: {}, isNew: true };
  }

  const data = await redis.getJSON(sessionKey(sessionId));
  return { id: sessionId, data: data || {}, isNew: !data };
}

export async function saveSession(res, sessionId, data) {
  await redis.setWithTTL(sessionKey(sessionId), data, SESSION_TTL_SECONDS);
  const signed = `${sessionId}.${sign(sessionId)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
}

export async function destroySession(res, sessionId) {
  if (sessionId) await redis.del(sessionKey(sessionId));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function sessionMiddleware() {
  return async (req, res, next) => {
    try {
      const session = await getSessionFromRequest(req);
      req.sessionId = session.id;
      req.session = session.data;
      req.saveSession = () => saveSession(res, req.sessionId, req.session);
      next();
    } catch (err) {
      next(err);
    }
  };
}
