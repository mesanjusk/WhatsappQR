# WhatsApp Web Clone MVP

A minimal, production-structured WhatsApp Web client built with Next.js, TypeScript,
MongoDB, and [`whatsapp-web.js`](https://wwebjs.dev/). Scan a QR code once and stay
connected — the session survives server restarts, deployments, and temporary
network drops, and is only cleared by an explicit logout.

Scope is deliberately narrow: QR login, persistent session, chat list, text
message history, sending/receiving text messages in real time, and logout. No
media, groups administration, calls, stories, or multi-account support.

## Architecture

```
Browser (React/Next.js UI)
   │  REST (fetch) + WebSocket (Socket.IO)
   ▼
Custom Node server (server.ts)
   ├── Next.js request handler (pages, API routes)
   ├── Socket.IO server (realtime push)
   └── WhatsAppManager (singleton)
          └── whatsapp-web.js Client (Puppeteer/Chromium)
                 └── RemoteAuth + wwebjs-mongo (MongoDB GridFS session store)

MongoDB
   ├── WhatsAppSession   (connection status/metadata — no secrets)
   ├── Chat              (synced chat list)
   ├── Message           (text message history, deduped by WhatsApp message id)
   └── whatsapp-<id>.files/.chunks (GridFS — the actual encrypted-by-WhatsApp
       browser session, owned by RemoteAuth/wwebjs-mongo, not a hand-rolled store)
```

The WhatsApp client is **not** created inside an API route. `server.ts` is a
custom Node HTTP server that boots Next.js, attaches Socket.IO, and creates
**one** `WhatsAppManager` at process startup. API routes only ever call
`getWhatsAppManager()` to reach that already-running singleton — they never
construct a client themselves. This is what keeps the WhatsApp connection
alive independently of any single HTTP request and prevents duplicate
clients from hot reload or concurrent requests.

## Files

| Path | Purpose |
|---|---|
| `server.ts` | Custom server: boots Next.js, Socket.IO, and the one `WhatsAppManager` |
| `src/lib/whatsapp/WhatsAppManager.ts` | Owns the `whatsapp-web.js` client, lifecycle events, reconnect/backoff, chat/message sync, dedup |
| `src/lib/whatsapp/instance.ts` | Process-wide singleton accessor for the manager |
| `src/lib/db/mongoose.ts` | Cached MongoDB connection |
| `src/models/{WhatsAppSession,Chat,Message}.ts` | Mongoose schemas + indexes |
| `src/lib/auth/*`, `src/middleware.ts` | App login (JWT cookie), route protection |
| `src/lib/socket/*` | Socket.IO auth middleware + client singleton |
| `src/app/api/whatsapp/*` | REST API (status/connect/chats/messages/logout) |
| `src/app/whatsapp/page.tsx` + `src/components/*` | Dashboard UI |

## Environment variables

Copy `.env.example` to `.env.local` and fill in real values:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/whatsapp_clone
NEXT_PUBLIC_APP_URL=http://localhost:3000
PORT=3000
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-now
JWT_SECRET=<openssl rand -hex 48>
WHATSAPP_SESSION_ID=default
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium   # only if not using bundled Chromium
WHATSAPP_BACKUP_SYNC_INTERVAL_MS=300000
```

`MONGODB_URI` is used both for app data (chats/messages/session metadata)
**and** as the backing store for the WhatsApp session itself (via
`RemoteAuth` + `wwebjs-mongo`), so a single database is all you need.

## MongoDB data model

- **WhatsAppSession** — one document (`sessionId: "default"`), tracks
  `status`, `phoneNumber`, `pushName`, `wid`, `lastConnectedAt`,
  `lastDisconnectedAt`, `lastError`. No auth secrets are stored here.
- **Chat** — synced from `client.getChats()` (top 50, by recency) and kept
  current on every message. Unique on `(sessionId, chatId)`.
- **Message** — text message history. Unique on `(sessionId, messageId)`
  where `messageId` is `message.id._serialized` from whatsapp-web.js — this
  is what prevents duplicates when WhatsApp replays/re-emits events (inserts
  that collide on this index are caught and silently ignored). Indexed on
  `(sessionId, chatId, timestamp)` for chat history queries.
- **GridFS buckets** (`whatsapp-<sessionId>.files`/`.chunks`) — the actual
  browser session archive, written by `wwebjs-mongo`'s `MongoStore`. This is
  the piece that lets the app skip QR scanning after a restart. It is never
  read or written by application code directly.

## How QR authentication works

1. `WhatsAppManager.initialize()` creates a `whatsapp-web.js` `Client` with
   `RemoteAuth` (store = `MongoStore` from `wwebjs-mongo`) and calls
   `client.initialize()`.
2. If no session exists in MongoDB, WhatsApp emits `qr`. The manager renders
   it to a PNG data URL with the `qrcode` package (the raw QR string never
   reaches the browser) and broadcasts it over Socket.IO (`whatsapp.qr` and
   `whatsapp.status`, status `WAITING_FOR_QR`).
3. Once scanned, `authenticated` → `AUTHENTICATING`, then `ready` →
   `CONNECTED`. The manager syncs the chat list at that point.
4. If a session **does** exist in MongoDB, `RemoteAuth` restores it into a
   fresh Chromium profile before WhatsApp Web even loads — `qr` never fires,
   and the flow goes straight to `authenticated` → `ready`.

## How persistence / reconnect works

- `RemoteAuth` periodically (`WHATSAPP_BACKUP_SYNC_INTERVAL_MS`, min 1
  minute) zips the browser profile and uploads it to MongoDB GridFS.
- On process restart, `server.ts` creates a fresh `WhatsAppManager` and calls
  `initialize()` immediately — `RemoteAuth` downloads and restores the last
  backup automatically, no QR needed.
- `whatsapp-web.js` only fires `disconnected` (and deletes the persisted
  session) for genuine terminal states — an explicit logout, or WhatsApp
  itself invalidating the pairing. Transient states (`OPENING`, `PAIRING`,
  `TIMEOUT`) are reflected as a soft `DISCONNECTED` status in the UI without
  touching the stored session.
- If the underlying Chromium process crashes outright (not a WhatsApp-level
  event), the manager detects the Puppeteer browser disconnect and
  re-initializes with exponential backoff (2s, 5s, 10s, 30s, 60s cap) —
  again restoring from MongoDB, no QR.

## How logout works

`POST /api/whatsapp/logout` → `WhatsAppManager.logout()` → `client.logout()`
(which WhatsApp itself uses to invalidate the pairing and clears the
GridFS-backed session) → the Puppeteer client is destroyed → status is set
to `LOGGED_OUT`. This is the only path that intentionally deletes the
persisted session; a normal process restart does not touch it.

## Realtime events (Socket.IO, path `/api/socket.io`)

`whatsapp.status`, `whatsapp.qr`, `whatsapp.ready`, `whatsapp.chat.updated`,
`whatsapp.message.received`, `whatsapp.message.sent`. The Socket.IO
handshake requires the same signed session cookie as the REST API.

## Security notes

- All `/api/whatsapp/*` routes and the `/whatsapp` page are protected by
  `src/middleware.ts` (JWT cookie check) and additionally re-verify the
  session inside each route handler.
- `POST /api/whatsapp/messages` re-validates that `chatId` belongs to this
  account's already-synced chat list before calling `sendMessage` — the
  browser can never target an arbitrary WhatsApp JID.
- The QR code is only ever exposed as a rendered PNG data URL, never the raw
  pairing string, and is not persisted to MongoDB.
- Logs (`src/lib/whatsapp/logger.ts`) never print raw `Error` objects, only
  `.message`, and message bodies are never logged.

## Known limitations

- **Single-process singleton.** `WhatsAppManager` lives in one Node
  process's memory. This app must run as a single persistent instance (one
  VM/container/PM2 process) — it does not work behind horizontal
  autoscaling/multiple replicas, since each instance would try to own the
  one WhatsApp account's browser session.
- **`tsx` at runtime.** `server.ts` runs via `tsx` (TypeScript executed
  directly by Node) rather than a separate compile step, for both dev and
  `npm start`. This is simple and fine for an MVP; a stricter production
  setup could add a `tsc`/`esbuild` build step for `server.ts` instead.
- Only text messages are supported end to end — no media, groups
  administration, calls, or stories, per the MVP scope.
- No read-receipt/ack UI; the `ack` field is stored but not surfaced.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in MONGODB_URI, ADMIN_EMAIL/PASSWORD, JWT_SECRET
npm run dev                  # http://localhost:3000 (custom server + Socket.IO)
```

Then:
1. Open `/login`, sign in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
2. You'll land on `/whatsapp` showing a QR code — scan it with WhatsApp on
   your phone (Linked Devices → Link a Device).
3. Once connected, the chat list loads automatically.

## Running in production

```bash
npm run build
npm start   # runs `tsx server.ts` with NODE_ENV=production
```

Chromium: by default the Chromium bundled with `whatsapp-web.js`'s
Puppeteer dependency is used. In a minimal Docker/Linux image without the
libraries Chromium needs, either use a base image that has them, or install
a system Chromium/Chrome and set `PUPPETEER_EXECUTABLE_PATH`.

## Manual test checklist

1. **QR** — fresh `MONGODB_URI` (no session yet) → `/whatsapp` shows a QR
   code within a few seconds.
2. **Login** — scan it → status goes `WAITING_FOR_QR` → `AUTHENTICATING` →
   `CONNECTED`, chat list appears.
3. **Persistence** — restart the server → `/whatsapp` goes straight to
   `CONNECTED`, no QR.
4. **Incoming message** — send a message from your phone to a chat → it
   appears in the UI in real time and in the `messages` collection.
5. **Outgoing message** — type and send from the UI → it reaches WhatsApp,
   appears in the conversation, and is stored once (not duplicated by the
   `message_create` echo).
6. **Duplicate prevention** — restart the server after having history in a
   chat, open that chat again → message count in MongoDB doesn't grow from
   re-sync/backfill.
7. **Logout** — click "Logout WhatsApp" → status `LOGGED_OUT`, QR screen
   returns, and a fresh scan is required to reconnect.
8. **Temporary disconnect** — turn phone WiFi off/on — UI shows
   `DISCONNECTED` briefly, then `CONNECTED` again with no QR prompt.

This sandbox environment does not have network access to provision a real
MongoDB instance or a phone to scan a QR code, so the above was verified as
far as possible without those: the full HTTP/auth/Socket.IO pipeline was
exercised end to end (login, middleware redirects, Socket.IO handshake
auth, status broadcast), `npm run build` and `tsc --noEmit` pass cleanly,
and the manager's error handling was confirmed against a real (refused)
MongoDB connection attempt. Steps 1–8 above should be re-verified against a
real MongoDB and WhatsApp account before relying on this in production.
