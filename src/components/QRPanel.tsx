"use client";

import type { WhatsAppStatus } from "@/types/whatsapp";

export function QRPanel({
  status,
  qr,
  lastError,
  onConnect,
}: {
  status: WhatsAppStatus;
  qr: string | null;
  lastError: string | null;
  onConnect: () => void;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 text-center">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-[#111b21]">Connect WhatsApp</h1>
        <p className="mb-6 text-sm text-[#667781]">
          Open WhatsApp on your phone → Linked Devices → Link a Device → Scan this QR code.
        </p>

        <div className="mx-auto mb-6 flex h-64 w-64 items-center justify-center rounded-lg border border-gray-200 bg-white">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="WhatsApp QR code" className="h-60 w-60" />
          ) : status === "AUTHENTICATING" ? (
            <p className="text-sm text-[#667781]">Authenticating WhatsApp...</p>
          ) : status === "INITIALIZING" || status === "WAITING_FOR_QR" ? (
            <p className="text-sm text-[#667781]">Generating QR code...</p>
          ) : (
            <p className="text-sm text-[#667781]">Connecting WhatsApp...</p>
          )}
        </div>

        {lastError && <p className="mb-4 text-sm text-red-600">{lastError}</p>}

        {(status === "LOGGED_OUT" || status === "DISCONNECTED" || status === "AUTH_FAILURE") && (
          <button
            onClick={onConnect}
            className="w-full rounded-lg bg-[#25d366] py-2 text-sm font-medium text-white transition hover:bg-[#1fb959]"
          >
            Connect WhatsApp
          </button>
        )}
      </div>
    </main>
  );
}
