import { NextResponse } from "next/server";
import { WhatsAppHttpError } from "@/lib/whatsapp/WhatsAppManager";

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof WhatsAppHttpError) {
    return NextResponse.json({ error: err.message }, { status: err.statusCode });
  }
  console.error("[API] Unexpected error", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
