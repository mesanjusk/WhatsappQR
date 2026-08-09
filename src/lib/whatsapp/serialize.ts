import type { ChatDoc } from "@/models/Chat";
import type { MessageDoc } from "@/models/Message";
import type { ChatSummary, MessageSummary } from "@/types/whatsapp";

type LeanChat = ChatDoc & { chatId: string };
type LeanMessage = MessageDoc & { messageId: string };

export function serializeChat(doc: LeanChat): ChatSummary {
  return {
    chatId: doc.chatId,
    name: doc.name,
    isGroup: Boolean(doc.isGroup),
    unreadCount: doc.unreadCount ?? 0,
    lastMessage: doc.lastMessage ?? null,
    lastMessageAt: doc.lastMessageAt ? new Date(doc.lastMessageAt).toISOString() : null,
  };
}

export function serializeMessage(doc: LeanMessage): MessageSummary {
  return {
    id: doc.messageId,
    chatId: doc.chatId,
    body: doc.body ?? "",
    fromMe: doc.fromMe,
    from: doc.from,
    to: doc.to,
    timestamp: new Date(doc.timestamp).toISOString(),
  };
}
