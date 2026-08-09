import type { WhatsAppStatus } from "@/types/whatsapp";

const LABELS: Record<WhatsAppStatus, { text: string; dot: string }> = {
  CONNECTED: { text: "Connected", dot: "🟢" },
  WAITING_FOR_QR: { text: "Waiting for QR scan", dot: "🟡" },
  AUTHENTICATING: { text: "Authenticating...", dot: "🟡" },
  INITIALIZING: { text: "Initializing...", dot: "🟡" },
  DISCONNECTED: { text: "Disconnected — reconnecting...", dot: "🔴" },
  AUTH_FAILURE: { text: "Authentication failed", dot: "🔴" },
  LOGGED_OUT: { text: "Logged out", dot: "🔴" },
};

export function ConnectionStatusBadge({ status }: { status: WhatsAppStatus }) {
  const info = LABELS[status] ?? { text: status, dot: "⚪" };
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-[#111b21]">
      <span aria-hidden>{info.dot}</span>
      {info.text}
    </span>
  );
}
