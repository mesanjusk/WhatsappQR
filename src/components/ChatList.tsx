"use client";

import type { ChatSummary } from "@/types/whatsapp";

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatList({
  chats,
  selectedChatId,
  onSelect,
  className = "",
}: {
  chats: ChatSummary[];
  selectedChatId: string | null;
  onSelect: (chatId: string) => void;
  className?: string;
}) {
  return (
    <div className={`flex h-full flex-col overflow-y-auto ${className}`}>
      {chats.length === 0 ? (
        <p className="p-4 text-sm text-[#667781]">No chats yet.</p>
      ) : (
        chats.map((chat) => (
          <button
            key={chat.chatId}
            onClick={() => onSelect(chat.chatId)}
            className={`flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left transition hover:bg-gray-50 ${
              selectedChatId === chat.chatId ? "bg-gray-100" : ""
            }`}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#25d366] text-sm font-semibold text-white">
              {chat.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-[#111b21]">{chat.name}</span>
                <span className="shrink-0 text-xs text-[#667781]">{formatTime(chat.lastMessageAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-[#667781]">{chat.lastMessage || "No messages yet"}</span>
                {chat.unreadCount > 0 && (
                  <span className="ml-2 shrink-0 rounded-full bg-[#25d366] px-2 py-0.5 text-xs font-semibold text-white">
                    {chat.unreadCount}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
