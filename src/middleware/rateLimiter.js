import * as redis from '../services/redisService.js';

const HTTP_WINDOW_MS = parseInt(process.env.HTTP_RATE_WINDOW_MS || '60000', 10);
const HTTP_MAX = parseInt(process.env.HTTP_RATE_MAX || '120', 10);
const WS_WINDOW_MS = parseInt(process.env.WS_RATE_WINDOW_MS || '10000', 10);
const WS_MAX_PER_USER = parseInt(process.env.WS_RATE_MAX_PER_USER || '40', 10);
const WS_MAX_PER_SOCKET = parseInt(process.env.WS_RATE_MAX_PER_SOCKET || '25', 10);
const BAN_AFTER = parseInt(process.env.WS_BAN_AFTER || '90', 10);
const BAN_SECONDS = parseInt(process.env.WS_BAN_SECONDS || '60', 10);
const TOGGLE_BURST_LIMIT = parseInt(process.env.TOGGLE_BURST_LIMIT || '2', 10);
const TOGGLE_COOLDOWN_MS = parseInt(process.env.TOGGLE_COOLDOWN_MS || '5000', 10);

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
}

function windowKey(prefix, identity, windowMs = Date.now()) {
  return `rate:${prefix}:${identity}:${Math.floor(windowMs / 1000)}`;
}

export function httpRateLimiter({ windowMs = HTTP_WINDOW_MS, max = HTTP_MAX } = {}) {
  return async (req, res, next) => {
    const identity = req.user?.userId || clientIp(req);
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `rate:http:${identity}:${bucket}`;

    try {
      const count = await redis.rateLimitIncr(key, windowMs);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      if (count > max) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function wsRateLimitCheck(socketId, userId) {
  const now = Date.now();
  const userBucket = Math.floor(now / WS_WINDOW_MS);
  const socketBucket = Math.floor(now / 1000);

  const cooldownKey = `cooldown:toggle:${userId}`;
  const burstKey = `rate:toggle-burst:${userId}`;
  const userKey = `rate:ws:user:${userId}:${userBucket}`;
  const socketKey = windowKey('ws:socket', socketId, socketBucket * 1000);
  const abuseKey = `rate:ws:abuse:${userId}:${Math.floor(now / 60000)}`;

  const cooldown = await redis.getJSON(cooldownKey);
  if (cooldown) {
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfterMs: Math.max(0, cooldown.until - now),
    };
  }

  const burstCount = await redis.rateLimitIncr(burstKey, TOGGLE_COOLDOWN_MS);
  if (burstCount > TOGGLE_BURST_LIMIT) {
    const until = now + TOGGLE_COOLDOWN_MS;
    await redis.setWithTTL(cooldownKey, { until }, Math.ceil(TOGGLE_COOLDOWN_MS / 1000));
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfterMs: TOGGLE_COOLDOWN_MS,
    };
  }
  const cooldownAfterMs = burstCount === TOGGLE_BURST_LIMIT ? TOGGLE_COOLDOWN_MS : 0;

  const [userCount, socketCount] = await Promise.all([
    redis.rateLimitIncr(userKey, WS_WINDOW_MS),
    redis.rateLimitIncr(socketKey, 1000),
  ]);

  if (userCount > WS_MAX_PER_USER || socketCount > WS_MAX_PER_SOCKET) {
    const abuseCount = await redis.rateLimitIncr(abuseKey, 60_000);
    if (abuseCount >= BAN_AFTER) {
      await redis.setWithTTL(`ban:user:${userId}`, { reason: 'toggle spam', at: Date.now() }, BAN_SECONDS);
    }
    return { allowed: false, reason: 'rate_limit', retryAfterMs: 1000 };
  }

  return { allowed: true, cooldownAfterMs };
}

export async function isBanned(userId) {
  return Boolean(await redis.getJSON(`ban:user:${userId}`));
}
