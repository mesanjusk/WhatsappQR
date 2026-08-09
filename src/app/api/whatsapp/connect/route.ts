import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { getWhatsAppManager } from "@/lib/whatsapp/instance";
import { errorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";

export async function POST() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const manager = getWhatsAppManager();
    // initialize() is idempotent — a no-op if already connecting/connected.
    void manager.initialize();
    return NextResponse.json(manager.getStatus());
  } catch (err) {
    return errorResponse(err);
  }
}
