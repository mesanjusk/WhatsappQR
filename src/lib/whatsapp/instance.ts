import type { WhatsAppManager } from "./WhatsAppManager";

// The manager is created exactly once, in server.ts at process boot, and
// cached on `global` so it survives module re-evaluation. It must NEVER be
// created lazily inside an API route — that would risk spinning up a second
// whatsapp-web.js client per request/worker.
//
// Known limitation: this singleton is only safe for a single Node.js
// process. It does not work across multiple instances/replicas (e.g. a
// horizontally-scaled serverless or multi-pod deployment) — those would each
// try to own the one WhatsApp account's browser session. Run this app as a
// single persistent Node process (one VM/container/PM2 instance).
declare global {
  var __whatsAppManager: WhatsAppManager | undefined;
}

export function setWhatsAppManager(manager: WhatsAppManager): void {
  global.__whatsAppManager = manager;
}

export function getWhatsAppManager(): WhatsAppManager {
  if (!global.__whatsAppManager) {
    throw new Error(
      "WhatsApp manager has not been initialized yet. It is created by the custom server (server.ts) at boot.",
    );
  }
  return global.__whatsAppManager;
}

export function hasWhatsAppManager(): boolean {
  return Boolean(global.__whatsAppManager);
}
