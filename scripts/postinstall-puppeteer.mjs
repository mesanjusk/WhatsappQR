import { execSync } from "node:child_process";

// Puppeteer is supposed to download its own Chrome during its own
// postinstall hook, but some PaaS build caches (Render's native Node
// environment observed in practice) restore node_modules from a snapshot
// in a way that skips that download, leaving
// "Could not find Chrome" at runtime. Force the install explicitly and
// idempotently here as a safety net — it's a no-op if Chrome is already
// present in Puppeteer's cache dir.
//
// Docker builds set PUPPETEER_SKIP_DOWNLOAD and use an apt-installed system
// Chromium instead (see Dockerfile), so this step is skipped there.
if (!process.env.PUPPETEER_SKIP_DOWNLOAD) {
  try {
    execSync("npx puppeteer browsers install chrome", { stdio: "inherit" });
  } catch (err) {
    console.error(
      "[postinstall] Failed to install Chrome for Puppeteer:",
      err instanceof Error ? err.message : err,
    );
    // Don't fail the whole `npm install` over this — surface the problem at
    // runtime (WhatsAppManager logs a clear error) rather than blocking deploys.
  }
}
