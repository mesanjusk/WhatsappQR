import "server-only";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionToken, type SessionPayload } from "./jwt";

/** Reads and verifies the app session cookie. Returns null if absent/invalid. */
export async function getServerSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Throws-free helper for API routes: returns the session or null. */
export async function requireSession(): Promise<SessionPayload | null> {
  return getServerSession();
}
