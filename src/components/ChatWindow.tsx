"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatSummary, MessageSummary } from "@/types/whatsapp";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatWindow({
  chat,
  messages,
  loading,
  onBack,
  onSend,
}: {
  chat: ChatSummary | null;
  messages: MessageSummary[];
  loading: boolean;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, chat?.chatId]);

  if (!chat) {
    return (
      <div className="hidden h-full flex-1 items-center justify-center bg-[#f0f2f5] text-sm text-[#667781] md:flex">
        Select a chat to start messaging
      </div>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-[#efeae2]">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-[#f0f2f5] px-4 py-3">
        <button onClick={onBack} className="text-[#54656f] md:hidden" aria-label="Back to chat list">
          ←
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#25d366] text-sm font-semibold text-white">
          {chat.name.slice(0, 1).toUpperCase()}
        </div>
        <span className="text-sm font-medium text-[#111b21]">{chat.name}</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {loading ? (
          <p className="text-center text-xs text-[#667781]">Loading messages...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-xs text-[#667781]">No messages yet. Say hello!</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                  m.fromMe ? "bg-[#d9fdd3] text-[#111b21]" : "bg-white text-[#111b21]"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1 text-right text-[10px] text-[#667781]">{formatTime(m.timestamp)}</p>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-gray-200 bg-[#f0f2f5] px-4 py-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message..."
          maxLength={4096}
          className="flex-1 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm outline-none focus:border-[#25d366]"
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="rounded-full bg-[#25d366] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#1fb959] disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
