import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { getWhatsAppManager } from "@/lib/whatsapp/instance";
import { errorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { chatId?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { chatId, text } = body;
  if (typeof chatId !== "string" || !chatId.trim()) {
    return NextResponse.json({ error: "chatId is required." }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Message text must not be empty." }, { status: 400 });
  }

  try {
    const manager = getWhatsAppManager();
    // sendMessage() re-validates that chatId belongs to this account's
    // synced chats, so the browser can never target an arbitrary WhatsApp
    // JID it hasn't already seen through the chat list.
    const message = await manager.sendMessage(chatId, text);
    return NextResponse.json({ message });
  } catch (err) {
    return errorResponse(err);
  }
}
