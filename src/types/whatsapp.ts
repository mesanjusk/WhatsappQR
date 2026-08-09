// Shared types safe to import from both server code and client components
// (no Node-only / whatsapp-web.js imports here).

export const WHATSAPP_STATUSES = [
  "DISCONNECTED",
  "INITIALIZING",
  "WAITING_FOR_QR",
  "AUTHENTICATING",
  "CONNECTED",
  "AUTH_FAILURE",
  "LOGGED_OUT",
] as const;

export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];

export interface StatusSnapshot {
  status: WhatsAppStatus;
  phoneNumber: string | null;
  pushName: string | null;
  qr: string | null;
  lastError: string | null;
}

export interface ChatSummary {
  chatId: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

export interface MessageSummary {
  id: string;
  chatId: string;
  body: string;
  fromMe: boolean;
  from: string;
  to: string;
  timestamp: string;
}

export interface StatusPayload extends StatusSnapshot {
  type: "whatsapp.status";
}
export interface QrPayload {
  type: "whatsapp.qr";
  qr: string | null;
}
export interface ReadyPayload {
  type: "whatsapp.ready";
  phoneNumber: string | null;
  pushName: string | null;
}
export interface ChatUpdatedPayload {
  type: "whatsapp.chat.updated";
  chat: ChatSummary;
}
export interface MessageReceivedPayload {
  type: "whatsapp.message.received";
  message: MessageSummary;
}
export interface MessageSentPayload {
  type: "whatsapp.message.sent";
  message: MessageSummary;
}

export type RealtimeEventMap = {
  "whatsapp.status": StatusPayload;
  "whatsapp.qr": QrPayload;
  "whatsapp.ready": ReadyPayload;
  "whatsapp.chat.updated": ChatUpdatedPayload;
  "whatsapp.message.received": MessageReceivedPayload;
  "whatsapp.message.sent": MessageSentPayload;
};
