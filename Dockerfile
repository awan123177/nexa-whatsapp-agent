# Multi-stage production Dockerfile for NEXA Agent on Render
# Stage 1: Builder
FROM node:22-bookworm AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace definitions and package configs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/security/package.json ./packages/security/
COPY packages/database/package.json ./packages/database/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tools/package.json ./packages/tools/
COPY packages/ai/package.json ./packages/ai/
COPY packages/whatsapp/package.json ./packages/whatsapp/
COPY packages/agent/package.json ./packages/agent/
COPY apps/api/package.json ./apps/api/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source trees
COPY packages ./packages
COPY apps ./apps

# Build all TypeScript packages and API server
RUN pnpm run build

# Stage 2: Production Runner
FROM node:22-bookworm AS runner

WORKDIR /app

# Configure Playwright shared browser binary directory accessible to all users
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy full application from builder
COPY --from=builder /app /app

# Install Chromium and required Linux system libraries
RUN mkdir -p /ms-playwright && \
    pnpm --filter @nexa/browser exec playwright install --with-deps chromium && \
    chmod -R 777 /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

# Production environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000

# Expose Render default port
EXPOSE 10000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 10000) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start NEXA API server
CMD ["node", "apps/api/dist/server.js"]
