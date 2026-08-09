import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { COOKIE_NAME } from "@/lib/auth/jwt";

// Runs on the Edge runtime, so it only verifies the JWT signature/expiry
// (no MongoDB access here). Real authorization + DB checks happen in the
// Node.js runtime route handlers.
async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const authed = await isValidSession(token);
  const { pathname } = request.nextUrl;

  const isApiRoute = pathname.startsWith("/api/whatsapp");
  const isProtectedPage = pathname.startsWith("/whatsapp");

  if (!authed && isApiRoute) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!authed && isProtectedPage) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (authed && pathname === "/login") {
    return NextResponse.redirect(new URL("/whatsapp", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/whatsapp/:path*", "/api/whatsapp/:path*", "/login"],
};
