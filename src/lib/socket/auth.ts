import type { Socket } from "socket.io";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth/jwt";

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

/** Socket.IO middleware: only authenticated app sessions may open the realtime channel. */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): Promise<void> {
  const token = parseCookie(socket.request.headers.cookie, COOKIE_NAME);
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    next(new Error("Unauthorized"));
    return;
  }
  next();
}
