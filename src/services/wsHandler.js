import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import * as redis from './redisService.js';
import { getSessionFromRequest } from './sessionService.js';
import { wsRateLimitCheck, isBanned } from '../middleware/rateLimiter.js';

// Local registry: Map<socketId, { ws, userId, userName, connectedAt }>
const clients = new Map();
let wss = null;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, excludeSocketId = null) {
  const msg = JSON.stringify(data);
  for (const [sid, client] of clients) {
    if (sid === excludeSocketId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

export function init(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    getSessionFromRequest(req).then((session) => {
      req.sessionId = session.id;
      req.session = session.data;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }).catch((err) => {
      console.error('[WS] Session load failed:', err.message);
      socket.destroy();
    });
  });

  wss.on('connection', (ws, req) => {
    const socketId = randomUUID();
    const session  = req.session || {};
    const userId   = session.userId   || null;
    const userName = session.userName || 'Anonymous';

    clients.set(socketId, { ws, userId, userName, connectedAt: Date.now() });

    send(ws, {
      type: 'welcome',
      socketId,
      userId,
      userName,
      total:       redis.TOTAL,
      isAnonymous: !userId,
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }
      await handleMessage(socketId, ws, msg);
    });

    ws.on('close', () => {
      clients.delete(socketId);
      broadcastStats();
    });

    ws.on('error', (err) => {
      console.error(`[WS] Socket ${socketId} error:`, err.message);
      clients.delete(socketId);
    });

    broadcastStats();
  });

  // Receive updates from OTHER server instances via Pub/Sub
  redis.onRemoteUpdate((data) => broadcast(data));

  // Periodic stats every 10s
  setInterval(broadcastStats, 10_000);

  console.log('[WS] WebSocket server initialized');
}

async function handleMessage(socketId, ws, msg) {
  const client = clients.get(socketId);
  if (!client) return;
  const { userId } = client;

  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      break;

    case 'toggle': {
      if (!userId) {
        send(ws, { type: 'error', message: 'Login required to toggle checkboxes.' });
        return;
      }
      if (await isBanned(userId)) {
        send(ws, { type: 'error', message: 'You have been temporarily restricted.' });
        return;
      }
      const limit = await wsRateLimitCheck(socketId, userId);
      if (!limit.allowed) {
        const seconds = Math.max(1, Math.ceil((limit.retryAfterMs || 1000) / 1000));
        const message = limit.reason === 'cooldown'
          ? `Please wait ${seconds}s before toggling again.`
          : 'Slow down! Too many toggles.';
        send(ws, {
          type: 'rate_limited',
          reason: limit.reason,
          retryAfterMs: limit.retryAfterMs || 1000,
          message,
        });
        return;
      }
      const index = parseInt(msg.index, 10);
      if (isNaN(index) || index < 0 || index >= redis.TOTAL) {
        send(ws, { type: 'error', message: 'Invalid checkbox index.' });
        return;
      }
      try {
        const newState = await redis.toggleCheckbox(index);
        await redis.publishUpdate({
          type:      'update',
          index,
          state:     newState,
          toggledBy: client.userName,
          toggledById: client.userId,
          socketId,
          at: Date.now(),
        });
        if (limit.cooldownAfterMs) {
          send(ws, {
            type: 'cooldown',
            retryAfterMs: limit.cooldownAfterMs,
            message: `Next toggle available in ${Math.ceil(limit.cooldownAfterMs / 1000)}s.`,
          });
        }
      } catch (err) {
        console.error('[WS] Toggle error:', err.message);
        send(ws, { type: 'error', message: 'Toggle failed. Please try again.' });
      }
      break;
    }

    default:
      send(ws, { type: 'error', message: `Unknown event type: ${msg.type}` });
  }
}

async function broadcastStats() {
  try {
    const checkedCount = await redis.getCheckedCount();
    broadcast({ type: 'stats', connected: clients.size, checkedCount, total: redis.TOTAL });
  } catch { /* non-critical */ }
}

export function getConnectedCount() {
  return clients.size;
}
