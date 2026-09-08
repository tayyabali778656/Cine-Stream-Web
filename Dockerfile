# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package manifests only — leverage Docker cache layers
COPY package*.json ./

# Install production deps only (no devDependencies in final image)
# Also set environment variable to skip Puppeteer chromium download during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production

# Install Chromium for Puppeteer
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      nodejs \
      yarn

# Security: Create a non-root user to run the app
RUN addgroup -g 1001 -S nodejs && \
    adduser -S cinestream -u 1001 -G nodejs

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps --chown=cinestream:nodejs /app/node_modules ./node_modules

# Copy source code (excludes files in .dockerignore)
COPY --chown=cinestream:nodejs . .

# Switch to non-root user
USER cinestream

EXPOSE 3000

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Health check — verify server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- --header="X-Health-Secret:${HEALTH_SECRET}" \
      http://localhost:3000/health || exit 1

CMD ["node", "serve.js"]
