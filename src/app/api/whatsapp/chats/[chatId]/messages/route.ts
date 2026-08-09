import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { getWhatsAppManager } from "@/lib/whatsapp/instance";
import { errorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ chatId: string }> }) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { chatId } = await context.params;
  if (!chatId) {
    return NextResponse.json({ error: "chatId is required." }, { status: 400 });
  }

  try {
    const manager = getWhatsAppManager();
    // getMessages() itself verifies chatId belongs to this WhatsApp account's
    // synced chat list before returning anything.
    const messages = await manager.getMessages(decodeURIComponent(chatId));
    return NextResponse.json({ messages });
  } catch (err) {
    return errorResponse(err);
  }
}
