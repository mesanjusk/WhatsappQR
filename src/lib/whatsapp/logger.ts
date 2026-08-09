const PREFIX = "[WhatsApp]";

// Never pass raw Error objects, auth tokens, session blobs, or message
// bodies to these — only short human-readable context. Keeps logs safe to
// ship to stdout/log aggregators without leaking secrets or private content.
function safe(arg: unknown): unknown {
  if (arg instanceof Error) return arg.message;
  return arg;
}

export const logger = {
  info(message: string, ...args: unknown[]) {
    console.log(PREFIX, message, ...args.map(safe));
  },
  warn(message: string, ...args: unknown[]) {
    console.warn(PREFIX, message, ...args.map(safe));
  },
  error(message: string, ...args: unknown[]) {
    console.error(PREFIX, message, ...args.map(safe));
  },
};
