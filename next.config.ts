import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // whatsapp-web.js / puppeteer / mongoose pull in Node-only native modules.
  // Keep them out of the client & server webpack bundling and use them only
  // via require() at runtime inside the Node.js runtime (custom server, API routes).
  serverExternalPackages: [
    "whatsapp-web.js",
    "wwebjs-mongo",
    "puppeteer",
    "puppeteer-core",
    "mongoose",
    "fs-extra",
    "archiver",
    "unzipper",
  ],
};

export default nextConfig;
