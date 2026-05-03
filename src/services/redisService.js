import { createClient, RESP_TYPES } from 'redis';

const CHECKBOX_KEY = 'checkboxes:bits';
const PUBSUB_CHANNEL = 'checkbox:updates';
export const TOTAL = parseInt(process.env.TOTAL_CHECKBOXES || '1000000', 10);

let publisher = null;
let binaryClient = null;
let subscriber = null;
let updateCallback = null;

export async function connect() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  publisher = createClient({ url });
  subscriber = createClient({ url });

  publisher.on('error', (err) => console.error('[Redis Publisher]', err));
  subscriber.on('error', (err) => console.error('[Redis Subscriber]', err));

  await publisher.connect();
  await subscriber.connect();
  binaryClient = publisher.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });

  await subscriber.subscribe(PUBSUB_CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      if (updateCallback) updateCallback(data);
    } catch (e) {
      console.error('[Redis Pub/Sub] Bad message:', e.message);
    }
  });

  console.log('[Redis] Connected. Publisher and subscriber ready.');
}

export function onRemoteUpdate(cb) {
  updateCallback = cb;
}

export async function toggleCheckbox(index) {
  if (index < 0 || index >= TOTAL) throw new Error('Index out of range');
  const newVal = await publisher.eval(
    `
      local current = redis.call('GETBIT', KEYS[1], ARGV[1])
      local next = 1 - current
      redis.call('SETBIT', KEYS[1], ARGV[1], next)
      return next
    `,
    { keys: [CHECKBOX_KEY], arguments: [String(index)] }
  );
  return Number(newVal);
}

export async function getBitfieldSlice(startBit, byteCount) {
  const startByte = Math.floor(startBit / 8);
  const endByte = startByte + byteCount - 1;
  const raw = await binaryClient.getRange(CHECKBOX_KEY, startByte, endByte);
  if (!raw || raw.length === 0) return Buffer.alloc(byteCount, 0);
  if (raw.length === byteCount) return raw;
  return Buffer.concat([raw, Buffer.alloc(byteCount - raw.length, 0)]);
}

export async function getCheckedCount() {
  return publisher.bitCount(CHECKBOX_KEY);
}

export async function publishUpdate(payload) {
  await publisher.publish(PUBSUB_CHANNEL, JSON.stringify(payload));
}

export async function rateLimitIncr(key, windowMs) {
  const multi = publisher.multi();
  multi.incr(key);
  multi.pExpire(key, windowMs);
  const [count] = await multi.exec();
  return count;
}

export async function rateLimitGet(key) {
  const val = await publisher.get(key);
  return val ? parseInt(val, 10) : 0;
}

export async function setWithTTL(key, value, ttlSeconds) {
  await publisher.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

export async function getJSON(key) {
  const raw = await publisher.get(key);
  return raw ? JSON.parse(raw) : null;
}

export async function del(key) {
  await publisher.del(key);
}

export function getPublisher() {
  return publisher;
}

export { CHECKBOX_KEY };
