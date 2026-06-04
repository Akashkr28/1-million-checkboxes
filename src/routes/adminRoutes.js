import { Router } from 'express';
import * as redis from '../services/redisService.js';
import * as wsHandler from '../services/wsHandler.js';
import { httpRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();
const startedAt = Date.now();

router.use(httpRateLimiter({ max: 90 }));

router.get('/metrics', async (_req, res) => {
  try {
    const [checkedCount, totalToggles, redisStats, recentActivity] = await Promise.all([
      redis.getCheckedCount(),
      redis.getTotalToggles(),
      redis.getRedisStats(),
      redis.getRecentActivity(12),
    ]);

    res.json({
      status: 'ok',
      app: {
        startedAt,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        nodeEnv: process.env.NODE_ENV || 'development',
        totalCheckboxes: redis.TOTAL,
      },
      checkboxes: {
        checkedCount,
        uncheckedCount: redis.TOTAL - checkedCount,
        checkedPercent: redis.TOTAL ? Number(((checkedCount / redis.TOTAL) * 100).toFixed(4)) : 0,
        totalToggles,
      },
      websockets: wsHandler.getConnectionStats(),
      redis: redisStats,
      rateLimits: {
        httpWindowMs: Number(process.env.HTTP_RATE_WINDOW_MS || 60000),
        httpMax: Number(process.env.HTTP_RATE_MAX || 120),
        wsWindowMs: Number(process.env.WS_RATE_WINDOW_MS || 10000),
        wsMaxPerUser: Number(process.env.WS_RATE_MAX_PER_USER || 40),
        wsMaxPerSocket: Number(process.env.WS_RATE_MAX_PER_SOCKET || 25),
        toggleBurstLimit: Number(process.env.TOGGLE_BURST_LIMIT || 2),
        toggleCooldownMs: Number(process.env.TOGGLE_COOLDOWN_MS || 5000),
      },
      recentActivity,
    });
  } catch (err) {
    console.error('[Admin] metrics error:', err.message);
    res.status(500).json({ status: 'error', error: 'Unable to load metrics' });
  }
});

router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    res.json({ activity: await redis.getRecentActivity(limit) });
  } catch {
    res.status(500).json({ error: 'Unable to load activity' });
  }
});

export default router;
