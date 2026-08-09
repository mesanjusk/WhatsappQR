import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createServer } from "http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";

import { socketAuthMiddleware } from "@/lib/socket/auth";
import { WhatsAppManager } from "@/lib/whatsapp/WhatsAppManager";
import { setWhatsAppManager } from "@/lib/whatsapp/instance";
import { logger } from "@/lib/whatsapp/logger";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;
const SOCKET_IO_PATH = "/api/socket.io";

const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const httpServer = createServer((req, res) => {
    // Requests under the socket.io path are handled exclusively by the
    // Socket.IO server's own request listener (attached below via the same
    // httpServer). Handing them to Next.js as well would double-respond.
    if (req.url && req.url.startsWith(SOCKET_IO_PATH)) return;
    handle(req, res);
  });

  const io = new SocketIOServer(httpServer, {
    path: SOCKET_IO_PATH,
  });
  io.use(socketAuthMiddleware);
  io.on("connection", (socket) => {
    logger.info(`Realtime client connected (${socket.id})`);
    socket.on("disconnect", () => {
      logger.info(`Realtime client disconnected (${socket.id})`);
    });
  });

  // The WhatsApp client is a long-running process owned by this custom
  // server, independent of any single HTTP request. API routes only ever
  // read this singleton via getWhatsAppManager() — they never construct one.
  const manager = new WhatsAppManager();
  manager.attachIO(io);
  setWhatsAppManager(manager);
  void manager.initialize();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    await manager.destroy();
    httpServer.close(() => process.exit(0));
    // Force-exit if close hangs (e.g. lingering sockets).
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  httpServer.listen(port, () => {
    logger.info(`Server ready on http://localhost:${port} (${dev ? "development" : "production"})`);
  });
}

main().catch((err) => {
  console.error("[Server] Fatal startup error", err);
  process.exit(1);
});
