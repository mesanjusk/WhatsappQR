"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket/client";
import type {
  ChatSummary,
  ChatUpdatedPayload,
  MessageReceivedPayload,
  MessageSentPayload,
  MessageSummary,
  StatusPayload,
  StatusSnapshot,
} from "@/types/whatsapp";
import { ConnectionStatusBadge } from "@/components/ConnectionStatusBadge";
import { QRPanel } from "@/components/QRPanel";
import { ChatList } from "@/components/ChatList";
import { ChatWindow } from "@/components/ChatWindow";

const EMPTY_STATUS: StatusSnapshot = {
  status: "INITIALIZING",
  phoneNumber: null,
  pushName: null,
  qr: null,
  lastError: null,
};

export default function WhatsAppPage() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusSnapshot>(EMPTY_STATUS);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [showConversationOnMobile, setShowConversationOnMobile] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const selectedChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  const loadChats = useCallback(async () => {
    const res = await fetch("/api/whatsapp/chats");
    if (!res.ok) return;
    const data = await res.json();
    setChats(data.chats ?? []);
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    setMessagesLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/chats/${encodeURIComponent(chatId)}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/whatsapp/status");
      if (res.ok && !cancelled) {
        const data: StatusSnapshot = await res.json();
        setStatus(data);
        if (data.status === "CONNECTED") void loadChats();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChats]);

  useEffect(() => {
    const socket = getSocket();

    const onStatus = (payload: StatusPayload) => {
      setStatus(payload);
      if (payload.status === "CONNECTED") void loadChats();
    };
    const onChatUpdated = (payload: ChatUpdatedPayload) => {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.chatId === payload.chat.chatId);
        const next = idx === -1 ? [payload.chat, ...prev] : prev.map((c, i) => (i === idx ? payload.chat : c));
        return [...next].sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
      });
    };
    const onMessage = (payload: MessageReceivedPayload | MessageSentPayload) => {
      if (payload.message.chatId === selectedChatIdRef.current) {
        setMessages((prev) => (prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]));
      }
    };

    socket.on("whatsapp.status", onStatus);
    socket.on("whatsapp.chat.updated", onChatUpdated);
    socket.on("whatsapp.message.received", onMessage);
    socket.on("whatsapp.message.sent", onMessage);

    return () => {
      socket.off("whatsapp.status", onStatus);
      socket.off("whatsapp.chat.updated", onChatUpdated);
      socket.off("whatsapp.message.received", onMessage);
      socket.off("whatsapp.message.sent", onMessage);
    };
  }, [loadChats]);

  async function handleConnect() {
    await fetch("/api/whatsapp/connect", { method: "POST" });
  }

  async function handleSelectChat(chatId: string) {
    setSelectedChatId(chatId);
    setShowConversationOnMobile(true);
    setChats((prev) => prev.map((c) => (c.chatId === chatId ? { ...c, unreadCount: 0 } : c)));
    await loadMessages(chatId);
  }

  async function handleSend(text: string) {
    if (!selectedChatId) return;
    const res = await fetch("/api/whatsapp/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: selectedChatId, text }),
    });
    if (res.ok) {
      const data = await res.json();
      setMessages((prev) => (prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]));
    }
  }

  async function handleWhatsAppLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/whatsapp/logout", { method: "POST" });
      setChats([]);
      setMessages([]);
      setSelectedChatId(null);
    } finally {
      setLoggingOut(false);
    }
  }

  async function handleAppLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (status.status !== "CONNECTED") {
    return <QRPanel status={status.status} qr={status.qr} lastError={status.lastError} onConnect={handleConnect} />;
  }

  const selectedChat = chats.find((c) => c.chatId === selectedChatId) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-[#f0f2f5] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-[#111b21]">WhatsApp</span>
          <ConnectionStatusBadge status={status.status} />
          {status.phoneNumber && <span className="text-xs text-[#667781]">+{status.phoneNumber}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleWhatsAppLogout}
            disabled={loggingOut}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-[#111b21] transition hover:bg-gray-100 disabled:opacity-60"
          >
            {loggingOut ? "Logging out..." : "Logout WhatsApp"}
          </button>
          <button
            onClick={handleAppLogout}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#667781] transition hover:bg-gray-100"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={`w-full shrink-0 border-r border-gray-200 md:block md:w-80 ${
            showConversationOnMobile ? "hidden" : "block"
          }`}
        >
          <ChatList chats={chats} selectedChatId={selectedChatId} onSelect={handleSelectChat} className="h-full" />
        </div>
        <div className={`w-full flex-1 md:block ${showConversationOnMobile ? "block" : "hidden"}`}>
          <ChatWindow
            chat={selectedChat}
            messages={messages}
            loading={messagesLoading}
            onBack={() => setShowConversationOnMobile(false)}
            onSend={handleSend}
          />
        </div>
      </div>
    </div>
  );
}
