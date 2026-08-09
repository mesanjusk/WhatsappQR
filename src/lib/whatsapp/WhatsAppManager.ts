import chromium from "@sparticuz/chromium";
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
// whatsapp-web.js's own page load for WhatsApp Web uses no navigation
// timeout at all (it waits forever), so a stuck browser/page load would
// otherwise hang initialize() indefinitely with no error and no retry.
const INIT_TIMEOUT_MS = 90_000;

export class WhatsAppHttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const DEFAULT_LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

type LaunchConfig = { executablePath: string | undefined; args: string[] };

/**
 * Relying on Puppeteer's own runtime Chrome download/cache machinery
 * (`puppeteer browsers install/list`) proved unreliable specifically on
 * Render's native Node environment: repeated attempts showed the install
 * reporting success, and even Puppeteer's own structured
 * getInstalledBrowsers() API confirming the binary as installed, while an
 * existsSync() check on that exact same path still failed moments later —
 * a platform-specific quirk that couldn't be root-caused further without
 * shell access to Render itself.
 *
 * @sparticuz/chromium sidesteps all of that: its Chromium binary ships
 * pre-downloaded *inside* the npm package (as a compressed archive),
 * extracted to a writable temp dir on first use — no separate runtime
 * network download/install step at all, so there's nothing left for a
 * PaaS's build/runtime environment to handle inconsistently. Verified
 * locally end-to-end (real page navigation, DOM access, clean shutdown).
 */
async function resolveLaunchConfig(): Promise<LaunchConfig> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Docker build path: a full system Chromium (apt-installed) is already provided.
    logger.info("Using PUPPETEER_EXECUTABLE_PATH (Docker/system Chromium)");
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: DEFAULT_LAUNCH_ARGS };
  }

  try {
    const executablePath = await chromium.executablePath();
    logger.info(`Resolved bundled Chromium executable: ${executablePath}`);
    // @sparticuz/chromium's recommended args include --single-process,
    // tuned for AWS Lambda's one-shot-invocation execution model. It's
    // documented in the whatsapp-web.js community as causing exactly the
    // "QR keeps regenerating, scan never completes" symptom for long-running
    // sessions — it destabilizes the background workers WhatsApp Web's
    // realtime connection depends on. This app is a persistent process, not
    // a one-shot Lambda invocation, so drop it.
    const args = chromium.args.filter((arg) => arg !== "--single-process");
    return { executablePath, args };
  } catch (err) {
    logger.error("Failed to resolve @sparticuz/chromium executable", err instanceof Error ? err.message : err);
    return { executablePath: undefined, args: DEFAULT_LAUNCH_ARGS };
  }
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
  private launchConfigResolved = false;
  private launchConfig: LaunchConfig = { executablePath: undefined, args: DEFAULT_LAUNCH_ARGS };

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

      if (!this.launchConfigResolved) {
        this.launchConfig = await resolveLaunchConfig();
        this.launchConfigResolved = true;
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
          executablePath: this.launchConfig.executablePath,
          args: this.launchConfig.args,
          // Pipes Chromium's own stdout/stderr straight to this process's,
          // so a launch/page-load hang shows Chromium's own diagnostics in
          // the deploy logs instead of just silence.
          dumpio: true,
        },
      });

      this.client = client;
      this.registerEventHandlers(client);

      logger.info("Initializing client");
      await withTimeout(client.initialize(), INIT_TIMEOUT_MS, "client.initialize()");
    } catch (err) {
      logger.error("Failed to initialize WhatsApp client", err);
      this.lastError = err instanceof Error ? err.message : "Unknown initialization error";
      const hungClient = this.client;
      this.client = null;
      if (hungClient) {
        // A timed-out initialize() promise keeps running in the background
        // (Node can't truly cancel it) — force-destroy so the underlying
        // browser process doesn't linger and emit confusing zombie events
        // after we've already moved on to a reconnect attempt.
        try {
          await hungClient.destroy();
        } catch (destroyErr) {
          logger.warn(
            "Error destroying client after failed/hung initialize()",
            destroyErr instanceof Error ? destroyErr.message : destroyErr,
          );
        }
      }
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
