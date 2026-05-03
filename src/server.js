import 'dotenv/config';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import * as redis from './services/redisService.js';
import * as auth from './services/authService.js';
import * as wsHandler from './services/wsHandler.js';
import { sessionMiddleware } from './services/sessionService.js';
import authRoutes from './routes/authRoutes.js';
import checkboxRoutes from './routes/checkboxRoutes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app    = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, '../public')));
app.use(sessionMiddleware());
app.use(auth.sessionAuth);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/auth', authRoutes);
app.use('/api/checkboxes', checkboxRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', connected: wsHandler.getConnectedCount() });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  await redis.connect();
  await auth.initOIDC();
  wsHandler.init(server);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🚀 1 Million Checkboxes running on http://localhost:${PORT}`);
    console.log(`   Total checkboxes : ${process.env.TOTAL_CHECKBOXES || 1_000_000}`);
    console.log(`   Redis             : ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
    console.log(`   OIDC              : ${process.env.OIDC_ISSUER || 'disabled (demo mode)'}\n`);
  });
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
