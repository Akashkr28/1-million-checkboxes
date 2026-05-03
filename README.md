# 1 Million Checkboxes

A real-time checkbox grid built with Node.js, Express, WebSockets and Redis. Users can log in, load a paged view of a million-checkbox bitmap, toggle boxes, and see updates from other connected browsers immediately.

## Tech Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js, Express, `ws`
- State and coordination: Redis bitmap plus Redis Pub/Sub
- Auth: OIDC/OAuth 2.0 authorization-code flow with PKCE, plus a demo login mode for local testing
- Rate limiting: custom Redis counters with expiries, no `express-rate-limit` or external rate-limit package

## Features

- Paged checkbox grid that renders 10,000 boxes at a time instead of pushing 1,000,000 DOM nodes into the browser.
- Redis bitmap storage: `checkboxes:bits` stores one checkbox per bit, so 1,000,000 checkboxes use about 125 KB.
- Atomic checkbox toggles with a Redis Lua script.
- WebSocket event flow for `welcome`, `toggle`, `update`, `stats`, `ping` and `pong`.
- Redis Pub/Sub channel `checkbox:updates` broadcasts updates across multiple Node server instances.
- Anonymous users can view state; logged-in users can toggle.
- Custom HTTP API rate limit by IP or user ID.
- Custom WebSocket spam protection by socket ID and user ID, with temporary Redis-backed bans.
- Visible 5 second toggle cooldown after two quick checkbox changes.
- Live activity feed showing recent checkbox updates across connected clients.
- Redis-backed signed-cookie sessions so auth also works during WebSocket upgrade.
- Docker Compose setup for Node.js and Redis.

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start Redis:

```bash
redis-server
```

Or with Docker:

```bash
docker run --rm -p 6379:6379 redis:7
```

3. Create your environment file:

```bash
cp .env.example .env
```

4. Start the app:

```bash
npm start
```

5. Open [http://localhost:3000](http://localhost:3000).

If `OIDC_ISSUER` is empty, `/auth/login` uses the built-in demo login so the real-time toggle flow can be tested locally without an identity provider.

## Run With Docker Compose

Use this when you want Node.js and Redis started together:

```bash
docker compose up --build
```

Then open [http://localhost:3000](http://localhost:3000).

To stop the stack:

```bash
docker compose down
```

To also remove the Redis volume:

```bash
docker compose down -v
```

## Deploy On Render

This repo includes `render.yaml`, which creates:

- one Docker web service for the Node.js app
- one Render Key Value instance for Redis-compatible bitmap, sessions, rate limits and Pub/Sub

Steps:

1. Push this project to a public GitHub repository.
2. In Render, choose **New > Blueprint**.
3. Select the GitHub repository.
4. Render will read `render.yaml` and ask for secret values.
5. Set `SESSION_SECRET` to a long random string.
6. For a real OIDC provider, set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI`.
7. If you are using demo login for the video, leave the OIDC values blank except `OIDC_REDIRECT_URI`.

After the first deploy, copy the Render app URL and use that as the live submission link. If using OIDC, set the provider callback URL to:

```text
https://your-render-app.onrender.com/auth/callback
```

## Environment Variables

- `PORT`: Express port, default `3000`
- `REDIS_URL`: Redis connection URL, default `redis://localhost:6379`
- `TOTAL_CHECKBOXES`: checkbox count, default `1000000`
- `SESSION_SECRET`: HMAC secret for signed session cookies
- `SESSION_COOKIE_NAME`: session cookie name
- `SESSION_TTL_SECONDS`: Redis session TTL
- `OIDC_ISSUER`: provider issuer URL; leave blank for demo mode
- `OIDC_CLIENT_ID`: OAuth/OIDC client ID
- `OIDC_CLIENT_SECRET`: client secret when required by the provider
- `OIDC_REDIRECT_URI`: callback URL, usually `http://localhost:3000/auth/callback`
- `OIDC_SCOPE`: default `openid email profile`
- `HTTP_RATE_WINDOW_MS`, `HTTP_RATE_MAX`: HTTP API limiter settings
- `WS_RATE_WINDOW_MS`, `WS_RATE_MAX_PER_USER`, `WS_RATE_MAX_PER_SOCKET`: WebSocket limiter settings
- `WS_BAN_AFTER`, `WS_BAN_SECONDS`: temporary abuse restriction settings
- `TOGGLE_BURST_LIMIT`, `TOGGLE_COOLDOWN_MS`: allows 2 quick toggles, then enforces a 5 second cooldown by default

## Auth Flow

When OIDC is configured, `/auth/login` creates a PKCE verifier, nonce and state value in the Redis-backed session, then redirects to the provider authorization endpoint. `/auth/callback` validates the returned state, exchanges the code for tokens, reads user claims from the ID token and userinfo endpoint, then stores `userId`, `email` and `name` in the session.

The WebSocket upgrade reads the same signed session cookie and loads the session from Redis, so socket actions are tied to the authenticated user. If no OIDC issuer is configured, demo mode creates a local user session for development.

## WebSocket Flow

1. Browser opens a WebSocket to the same host.
2. Server assigns a UUID socket ID and sends a `welcome` event.
3. Logged-in clients send `{ "type": "toggle", "index": 123 }`.
4. Server checks auth, ban state, per-user and per-socket rate limits.
5. Redis atomically flips the target bit.
6. Server publishes the update on Redis Pub/Sub.
7. Every server instance receives the Pub/Sub message and broadcasts `{ "type": "update", "index": 123, "state": 1 }` to connected clients.
8. The frontend updates the visible checkbox and appends the event to the live activity feed.

## Rate Limiting Logic

HTTP requests use Redis keys like `rate:http:<ip-or-user>:<bucket>`. Each request increments the key and sets an expiry matching the window. When the counter exceeds `HTTP_RATE_MAX`, the API returns `429`.

WebSocket toggles use two counters:

- `rate:ws:user:<userId>:<bucket>` limits total toggles per logged-in user.
- `rate:ws:socket:<socketId>:<second>` limits bursts from one socket connection.
- `rate:toggle-burst:<userId>` allows two quick checkbox changes in a 5 second window.
- `cooldown:toggle:<userId>` blocks extra toggles until the cooldown expires.

Repeated violations increment `rate:ws:abuse:<userId>:<minute>`. If the abuse counter crosses `WS_BAN_AFTER`, the server stores `ban:user:<userId>` with a short TTL and rejects toggle events until it expires.

## Redis Keys

- `checkboxes:bits`: compact Redis bitmap for all checkbox states
- `checkbox:updates`: Pub/Sub channel for cross-instance updates
- `session:<sessionId>`: authenticated session payload
- `rate:*`: HTTP and WebSocket rate-limit counters
- `ban:user:<userId>`: temporary abuse restriction

## Submission Links

- Public GitHub repository: add your repository URL here
- Live deployed app: add your deployed URL here if available
- YouTube unlisted demo video: add your YouTube URL here

The demo video should show login, grid loading, a checkbox toggle, and the same update appearing in two browser windows.
