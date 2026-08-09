# Persistent Node server for the WhatsApp Web clone MVP.
# Runs the custom server.ts (Next.js + Socket.IO + the WhatsAppManager
# singleton) as one long-lived process — required because whatsapp-web.js
# needs a real, continuously-running Chromium/Puppeteer session. This will
# NOT work on serverless platforms (e.g. Vercel); use a persistent host
# such as Render, Railway, Fly.io, or a VPS.

FROM node:20-bookworm-slim AS base

# System Chromium + the shared libraries it needs to actually launch
# headless. Installing Chromium from apt (instead of Puppeteer's bundled
# download) keeps the image smaller and avoids sandbox/glibc mismatches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own Chromium download — we use the system package above.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Render (and most PaaS hosts) inject PORT at runtime; server.ts already
# reads process.env.PORT, so no hardcoded value is needed here.
EXPOSE 3000

CMD ["npm", "start"]
