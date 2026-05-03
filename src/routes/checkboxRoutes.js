import { Router } from 'express';
import * as redis from '../services/redisService.js';
import { httpRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();
const BYTES_PER_PAGE = 4096;
const MAX_BYTES      = 65536;

router.use(httpRateLimiter());

router.get('/info', (_req, res) => {
  res.json({
    total:      redis.TOTAL,
    bytesPerPage: BYTES_PER_PAGE,
    totalBytes: Math.ceil(redis.TOTAL / 8),
  });
});

router.get('/state', async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const bytes  = Math.min(MAX_BYTES, Math.max(1, parseInt(req.query.bytes || `${BYTES_PER_PAGE}`, 10)));
    const totalBytes = Math.ceil(redis.TOTAL / 8);
    if (offset >= totalBytes) return res.json({ offset, bytes: 0, data: '' });

    const clampedBytes = Math.min(bytes, totalBytes - offset);
    const buf = await redis.getBitfieldSlice(offset * 8, clampedBytes);
    res.json({ offset, bytes: clampedBytes, data: buf.toString('base64') });
  } catch (err) {
    console.error('[API] state error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/count', async (_req, res) => {
  try {
    const count = await redis.getCheckedCount();
    res.json({ count, total: redis.TOTAL });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;