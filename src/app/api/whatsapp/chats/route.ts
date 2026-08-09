import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { getWhatsAppManager } from "@/lib/whatsapp/instance";
import { errorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const manager = getWhatsAppManager();
    const chats = await manager.getChats();
    return NextResponse.json({ chats });
  } catch (err) {
    return errorResponse(err);
  }
}
