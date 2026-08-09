import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import path from "node:path";
import { getInstalledBrowsers } from "@puppeteer/browsers";
import mongoose from "mongoose";
import QRCode from "qrcode";
import { Client, RemoteAuth, type Chat as WWebChat, type Message as WWebMessage } from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import type { Server as SocketIOServer } from "socket.io";

import { connectToDatabase } from "@/lib/db/mongoose";
import { WhatsAppSession } from "@/models/WhatsAppSession";
import { Chat } from "@/models/Chat";
import { Message, type MessageDoc } from "@/models/Message";
import { logger } from "./logger";
import { serializeChat, serializeMessage } from "./serialize";
import type { ChatSummary, MessageSummary, StatusSnapshot, WhatsAppStatus } from "@/types/whatsapp";

// Read lazily via functions (not module-level constants): this module is
// imported transitively before the custom server's env-loading call runs
// (ESM hoists all imports ahead of any top-level statement), so a
// module-level `process.env.X` read here would freeze as undefined.
function getSessionId(): string {
  return process.env.WHATSAPP_SESSION_ID || "default";
}
// Single-admin MVP: every record is tagged with the one app user that owns
// this WhatsApp account.
function getOwnerUserId(): string {
  return process.env.ADMIN_EMAIL || "admin";
}

const MAX_CHATS = 50;
const MAX_HISTORY_PER_CHAT = 30;
const MIN_STORED_MESSAGES_BEFORE_BACKFILL = 10;
const MAX_MESSAGE_LENGTH = 4096;
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];

export class WhatsAppHttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function runPuppeteerCli(cliPath: string, args: string[], timeoutMs: number) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    timeout: timeoutMs,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
  };
}

/**
 * Puppeteer is supposed to download its own Chrome during `npm install`,
 * but some PaaS build caches (observed on Render's native Node
 * environment) restore node_modules from a snapshot in a way that skips
 * that download, leaving "Could not find Chrome" only once the server
 * actually tries to launch it. A build-time postinstall step can't be
 * trusted to always run, so this checks/installs at runtime instead —
 * synchronously, in the same process and filesystem that is about to
 * launch Puppeteer, right before it does.
 *
 * Resolves Puppeteer's own local CLI script directly (not via `npx`) so
 * this is guaranteed to run the exact same puppeteer install that
 * whatsapp-web.js itself requires — no risk of npx resolving a different
 * globally-fetched puppeteer version whose Chrome build id wouldn't match.
 *
 * Returns the resolved executable path to pass explicitly as
 * `puppeteer.executablePath` on the Client. Setting PUPPETEER_CACHE_DIR
 * alone is NOT enough: `import { Client } from "whatsapp-web.js"` at the
 * top of this file already required puppeteer (which computes its default
 * cache/executable path at that point) before this function — which runs
 * later, inside initialize() — ever gets a chance to set the env var. By
 * the time it's set, Puppeteer's own module-level default is already
 * fixed, so the only reliable way to point it at the installed browser is
 * to hand it the resolved path directly.
 *
 * The install step still shells out to Puppeteer's own CLI (it correctly
 * resolves the exact Chrome build id this puppeteer version expects,
 * without needing that hardcoded here), but the *lookup* of what actually
 * ended up installed uses @puppeteer/browsers' structured
 * getInstalledBrowsers() API directly — not text-parsed CLI output — so
 * there's no risk of a parsing mismatch producing a path that looks right
 * but isn't the one Puppeteer itself would resolve.
 */
async function resolveChromeExecutablePath(): Promise<string | undefined> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Docker build path: a system Chromium is already provided.
    logger.info("Using PUPPETEER_EXECUTABLE_PATH (Docker/system Chromium)");
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  if (!process.env.PUPPETEER_CACHE_DIR) {
    process.env.PUPPETEER_CACHE_DIR = path.join("/tmp", "puppeteer-cache");
  }
  const cacheDir = process.env.PUPPETEER_CACHE_DIR;

  try {
    const fsStats = statfsSync("/tmp");
    const freeMb = Math.round((fsStats.bavail * fsStats.bsize) / 1024 / 1024);
    logger.info(`Chrome cache dir: ${cacheDir} (/tmp has ${freeMb}MB free)`);
  } catch (err) {
    logger.warn("Could not stat /tmp filesystem", err instanceof Error ? err.message : err);
  }

  let cliPath: string;
  try {
    cliPath = require.resolve("puppeteer/lib/cjs/puppeteer/node/cli.js");
  } catch (err) {
    logger.error("Could not resolve puppeteer's CLI script", err);
    return undefined;
  }

  logger.info(`Installing Chrome for Puppeteer via ${cliPath}`);
  const install = runPuppeteerCli(cliPath, ["browsers", "install", "chrome"], 180_000);
  if (install.error) {
    logger.error("Chrome install process failed to start", install.error.message);
  } else {
    logger.info(
      `Chrome install exit=${install.status} stdout="${install.stdout || "(empty)"}" stderr="${install.stderr || "(empty)"}"`,
    );
  }

  let installed: Awaited<ReturnType<typeof getInstalledBrowsers>>;
  try {
    installed = await getInstalledBrowsers({ cacheDir });
  } catch (err) {
    logger.error("getInstalledBrowsers() failed", err instanceof Error ? err.message : err);
    return undefined;
  }
  logger.info(`getInstalledBrowsers(): ${JSON.stringify(installed.map((b) => ({ browser: b.browser, buildId: b.buildId, executablePath: b.executablePath })))}`);

  const chrome = installed.find((b) => b.browser === "chrome");
  if (!chrome || !existsSync(chrome.executablePath)) {
    logger.error(
      `Could not resolve a usable Chrome executable path (found: ${chrome?.executablePath ?? "none"})`,
    );
    return undefined;
  }

  logger.info(`Resolved Chrome executable path: ${chrome.executablePath}`);
  return chrome.executablePath;
}

export class WhatsAppManager {
  private client: Client | null = null;
  private io: SocketIOServer | null = null;

  private status: WhatsAppStatus = "DISCONNECTED";
  private qrDataUrl: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private wid: string | null = null;
  private lastError: string | null = null;

  private initializing = false;
  private loggingOut = false;
  private shuttingDown = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chromeResolved = false;
  private chromeExecutablePath: string | undefined = undefined;

  attachIO(io: SocketIOServer): void {
    this.io = io;
  }

  getStatus(): StatusSnapshot {
    return {
      status: this.status,
      phoneNumber: this.phoneNumber,
      pushName: this.pushName,
      qr: this.qrDataUrl,
      lastError: this.lastError,
    };
  }

  /**
   * Boots the whatsapp-web.js client. Safe to call repeatedly/concurrently —
   * a second call while one is already in flight (or already connected) is a
   * no-op, which is what keeps this a true singleton across API requests.
   */
  async initialize(): Promise<void> {
    if (this.initializing || this.client || this.shuttingDown) return;
    this.initializing = true;

    try {
      await connectToDatabase();
      await this.setStatus("INITIALIZING");

      if (!this.chromeResolved) {
        this.chromeExecutablePath = await resolveChromeExecutablePath();
        this.chromeResolved = true;
      }

      const store = new MongoStore({ mongoose });
      const backupSyncIntervalMs = Number(process.env.WHATSAPP_BACKUP_SYNC_INTERVAL_MS) || 5 * 60 * 1000;

      const client = new Client({
        authStrategy: new RemoteAuth({
          store,
          clientId: getSessionId(),
          backupSyncIntervalMs: Math.max(backupSyncIntervalMs, 60_000),
        }),
        puppeteer: {
          headless: true,
          executablePath: this.chromeExecutablePath,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        },
      });

      this.client = client;
      this.registerEventHandlers(client);

      logger.info("Initializing client");
      await client.initialize();
    } catch (err) {
      logger.error("Failed to initialize WhatsApp client", err);
      this.lastError = err instanceof Error ? err.message : "Unknown initialization error";
      this.client = null;
      await this.setStatus("DISCONNECTED", { lastDisconnectedAt: new Date() });
      this.scheduleReconnect();
    } finally {
      this.initializing = false;
    }
  }

  private registerEventHandlers(client: Client): void {
    client.on("qr", async (qr: string) => {
      logger.info("QR generated");
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
      } catch (err) {
        logger.error("Failed to render QR code to an image", err);
        this.qrDataUrl = null;
      }
      this.reconnectAttempts = 0;
      await this.setStatus("WAITING_FOR_QR");
      this.emit("whatsapp.qr", { type: "whatsapp.qr", qr: this.qrDataUrl });
    });

    client.on("authenticated", async () => {
      logger.info("Authentication successful");
      this.qrDataUrl = null;
      await this.setStatus("AUTHENTICATING");
    });

    client.on("auth_failure", async (message: string) => {
      logger.error("Authentication failure", message);
      this.lastError = typeof message === "string" ? message : "Authentication failure";
      this.client = null;
      await this.setStatus("AUTH_FAILURE", { lastDisconnectedAt: new Date() });
      this.scheduleReconnect();
    });

    client.on("ready", async () => {
      logger.info("Client ready");
      this.reconnectAttempts = 0;
      this.qrDataUrl = null;
      const info = client.info;
      this.phoneNumber = info?.wid?.user ?? null;
      this.pushName = info?.pushname ?? null;
      this.wid = info?.wid?._serialized ?? null;

      await this.setStatus("CONNECTED", { lastConnectedAt: new Date() });
      this.emit("whatsapp.ready", { type: "whatsapp.ready", phoneNumber: this.phoneNumber, pushName: this.pushName });

      // Best-effort: detect the underlying Chromium process dying outright
      // (crash / OOM kill) so we can reconnect without requiring a new QR —
      // the persisted MongoDB session is untouched by this kind of failure.
      client.pupBrowser?.once("disconnected", () => {
        if (this.loggingOut || this.shuttingDown) return;
        logger.warn("Puppeteer browser disconnected unexpectedly");
        this.client = null;
        void this.setStatus("DISCONNECTED", { lastDisconnectedAt: new Date() });
        this.scheduleReconnect();
      });

      await this.syncChats();
    });

    client.on("message", async (message: WWebMessage) => {
      await this.handleIncomingMessage(message);
    });

    client.on("message_create", async (message: WWebMessage) => {
      await this.handleIncomingMessage(message);
    });

    client.on("change_state", (state: string) => {
      logger.info(`State changed: ${state}`);
      if (state === "CONNECTED") return;
      // Transient states (OPENING/PAIRING/TIMEOUT) surface as a soft
      // "disconnected" in the UI without touching the persisted session.
      this.status = "DISCONNECTED";
      this.emit("whatsapp.status", { type: "whatsapp.status", ...this.getStatus() });
    });

    client.on("disconnected", async (reason: string) => {
      // whatsapp-web.js only fires this for terminal states (it has already
      // deleted the persisted RemoteAuth session by this point), so treat it
      // as a real logout/invalidation rather than a transient blip.
      logger.warn(`Disconnected: ${reason}`);
      if (this.loggingOut) return;
      this.client = null;
      this.phoneNumber = null;
      this.pushName = null;
      this.wid = null;
      this.qrDataUrl = null;
      await this.setStatus("LOGGED_OUT", { lastDisconnectedAt: new Date() });
      try {
        await client.destroy();
      } catch {
        // browser may already be closed
      }
    });

    client.on("remote_session_saved", () => {
      logger.info("Session backed up to MongoDB");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.loggingOut || this.shuttingDown) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts += 1;
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.initialize();
    }, delay);
  }

  private async setStatus(
    status: WhatsAppStatus,
    extra: Partial<{ lastConnectedAt: Date; lastDisconnectedAt: Date }> = {},
  ): Promise<void> {
    this.status = status;
    try {
      await connectToDatabase();
      await WhatsAppSession.findOneAndUpdate(
        { sessionId: getSessionId() },
        {
          $set: {
            userId: getOwnerUserId(),
            sessionId: getSessionId(),
            status,
            phoneNumber: this.phoneNumber ?? undefined,
            pushName: this.pushName ?? undefined,
            wid: this.wid ?? undefined,
            lastError: this.lastError ?? undefined,
            ...extra,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      logger.error("Failed to persist WhatsApp session status", err);
    }
    this.emit("whatsapp.status", { type: "whatsapp.status", ...this.getStatus() });
  }

  private emit<E extends "whatsapp.status" | "whatsapp.qr" | "whatsapp.ready" | "whatsapp.chat.updated" | "whatsapp.message.received" | "whatsapp.message.sent">(
    event: E,
    payload: Record<string, unknown>,
  ): void {
    this.io?.emit(event, payload);
  }

  private async syncChats(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await connectToDatabase();
      const chats: WWebChat[] = await client.getChats();
      const top = [...chats].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, MAX_CHATS);

      for (const c of top) {
        await Chat.findOneAndUpdate(
          { sessionId: getSessionId(), chatId: c.id._serialized },
          {
            $set: {
              userId: getOwnerUserId(),
              sessionId: getSessionId(),
              name: c.name || c.id.user,
              isGroup: c.isGroup,
              unreadCount: c.unreadCount ?? 0,
              lastMessage: c.lastMessage?.body ?? undefined,
              lastMessageAt: c.lastMessage?.timestamp ? new Date(c.lastMessage.timestamp * 1000) : undefined,
            },
          },
          { upsert: true },
        );
      }
      logger.info(`Synced ${top.length} chats`);
    } catch (err) {
      logger.error("Failed to sync chats", err);
    }
  }

  private async handleIncomingMessage(message: WWebMessage): Promise<void> {
    try {
      const messageId = message.id?._serialized;
      if (!messageId) return;
      const chatId = message.fromMe ? message.to : message.from;
      const timestamp = new Date((message.timestamp || Math.floor(Date.now() / 1000)) * 1000);

      await connectToDatabase();

      let created: MessageDoc & { _id: unknown };
      try {
        created = await Message.create({
          userId: getOwnerUserId(),
          sessionId: getSessionId(),
          chatId,
          messageId,
          from: message.from,
          to: message.to,
          body: message.body ?? "",
          fromMe: message.fromMe,
          ack: message.ack,
          timestamp,
        });
      } catch (err: unknown) {
        if (isDuplicateKeyError(err)) {
          logger.info("Duplicate message ignored");
          return;
        }
        throw err;
      }

      let chatDoc = await Chat.findOne({ sessionId: getSessionId(), chatId });
      if (!chatDoc) {
        let name = chatId;
        let isGroup = chatId.endsWith("@g.us");
        try {
          const wwebChat = await message.getChat();
          name = wwebChat.name || name;
          isGroup = wwebChat.isGroup;
        } catch (err) {
          logger.warn("Could not resolve chat metadata for new chat", err);
        }
        chatDoc = await Chat.create({
          userId: getOwnerUserId(),
          sessionId: getSessionId(),
          chatId,
          name,
          isGroup,
          unreadCount: 0,
        });
      }

      await Chat.updateOne(
        { sessionId: getSessionId(), chatId },
        {
          $set: { lastMessage: created.body, lastMessageAt: created.timestamp },
          ...(created.fromMe ? {} : { $inc: { unreadCount: 1 } }),
        },
      );

      const eventType = created.fromMe ? "whatsapp.message.sent" : "whatsapp.message.received";
      const messageSummary: MessageSummary = serializeMessage(created);
      this.emit(eventType, { type: eventType, message: messageSummary });

      const updatedChat = await Chat.findOne({ sessionId: getSessionId(), chatId }).lean();
      if (updatedChat) {
        const chatSummary: ChatSummary = serializeChat(updatedChat);
        this.emit("whatsapp.chat.updated", { type: "whatsapp.chat.updated", chat: chatSummary });
      }
    } catch (err) {
      logger.error("Failed to handle incoming message", err);
    }
  }

  async getChats(): Promise<ChatSummary[]> {
    await connectToDatabase();
    const chats = await Chat.find({ sessionId: getSessionId() }).sort({ lastMessageAt: -1 }).limit(MAX_CHATS).lean();
    return chats.map(serializeChat);
  }

  async getMessages(chatId: string): Promise<MessageSummary[]> {
    await connectToDatabase();
    const chatDoc = await Chat.findOne({ sessionId: getSessionId(), chatId });
    if (!chatDoc) {
      throw new WhatsAppHttpError("Chat not found for this WhatsApp account.", 404);
    }

    let messages = await Message.find({ sessionId: getSessionId(), chatId })
      .sort({ timestamp: -1 })
      .limit(MAX_HISTORY_PER_CHAT)
      .lean();

    if (messages.length < MIN_STORED_MESSAGES_BEFORE_BACKFILL && this.client && this.status === "CONNECTED") {
      try {
        const wwebChat = await this.client.getChatById(chatId);
        const history = await wwebChat.fetchMessages({ limit: MAX_HISTORY_PER_CHAT });
        for (const m of history) {
          const messageId = m.id?._serialized;
          if (!messageId) continue;
          try {
            await Message.create({
              userId: getOwnerUserId(),
              sessionId: getSessionId(),
              chatId,
              messageId,
              from: m.from,
              to: m.to,
              body: m.body ?? "",
              fromMe: m.fromMe,
              ack: m.ack,
              timestamp: new Date((m.timestamp || 0) * 1000),
            });
          } catch (err) {
            if (!isDuplicateKeyError(err)) logger.error("Failed to persist backfilled message", err);
          }
        }
        messages = await Message.find({ sessionId: getSessionId(), chatId })
          .sort({ timestamp: -1 })
          .limit(MAX_HISTORY_PER_CHAT)
          .lean();
      } catch (err) {
        logger.error("Failed to backfill message history from WhatsApp", err);
      }
    }

    if (chatDoc.unreadCount) {
      await Chat.updateOne({ sessionId: getSessionId(), chatId }, { $set: { unreadCount: 0 } });
      const updatedChat = await Chat.findOne({ sessionId: getSessionId(), chatId }).lean();
      if (updatedChat) {
        this.emit("whatsapp.chat.updated", { type: "whatsapp.chat.updated", chat: serializeChat(updatedChat) });
      }
    }

    return messages.reverse().map(serializeMessage);
  }

  async sendMessage(chatId: string, text: string): Promise<MessageSummary> {
    if (!this.client || this.status !== "CONNECTED") {
      throw new WhatsAppHttpError("WhatsApp is not connected.", 409);
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new WhatsAppHttpError("Message text must not be empty.", 400);
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new WhatsAppHttpError(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, 400);
    }

    await connectToDatabase();
    const chatDoc = await Chat.findOne({ sessionId: getSessionId(), chatId });
    if (!chatDoc) {
      throw new WhatsAppHttpError("Unknown chat for this WhatsApp account.", 404);
    }

    let sent: WWebMessage;
    try {
      sent = await this.client.sendMessage(chatId, trimmed);
    } catch (err) {
      logger.error("Failed to send message", err);
      throw new WhatsAppHttpError("Failed to send message via WhatsApp.", 502);
    }

    // Persistence + realtime broadcast happens uniformly through the
    // message_create handler (fires for outgoing messages too), so the same
    // dedup path covers messages sent from here and from linked devices.
    return {
      id: sent.id._serialized,
      chatId,
      body: trimmed,
      fromMe: true,
      from: sent.from,
      to: sent.to,
      timestamp: new Date((sent.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  }

  async logout(): Promise<void> {
    logger.info("Logging out");
    this.loggingOut = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (this.client) {
        await this.client.logout();
      }
    } catch (err) {
      logger.error("Error while logging out from WhatsApp", err);
    }

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.destroy();
      } catch {
        // browser may already be closed by client.logout()
      }
    }

    this.phoneNumber = null;
    this.pushName = null;
    this.wid = null;
    this.qrDataUrl = null;
    this.lastError = null;
    this.reconnectAttempts = 0;
    await this.setStatus("LOGGED_OUT", { lastDisconnectedAt: new Date() });
    this.loggingOut = false;
  }

  /** Graceful process shutdown: closes the browser but keeps the persisted
   * MongoDB session intact so the next boot restores without a QR scan. */
  async destroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        logger.warn("Error while shutting down WhatsApp client", err);
      }
      this.client = null;
    }
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: number }).code === 11000);
}
