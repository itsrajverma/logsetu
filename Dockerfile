# syntax=docker/dockerfile:1.7
# LogSetu server image. Build from the repo root:  docker build -t logsetu .
ARG NODE_VERSION=22

# ---------- deps: install workspace dependencies for the server only ----------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++ && npm install -g pnpm@12
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY packages/logsetu-js/package.json packages/logsetu-js/
COPY examples/nextjs-app/package.json examples/nextjs-app/
RUN pnpm install --frozen-lockfile --filter @logsetu/server

# ---------- build: generate Prisma clients + Next.js standalone output ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/server apps/server
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @logsetu/server build

# ---------- runner: minimal image with the standalone server ----------
FROM node:${NODE_VERSION}-alpine AS runner
ARG LOGSETU_VERSION=dev
RUN apk add --no-cache libc6-compat wget && addgroup -S logsetu && adduser -S -G logsetu logsetu
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8686 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/logsetu.db \
    LOGSETU_VERSION=${LOGSETU_VERSION}

COPY --from=build --chown=logsetu:logsetu /app/apps/server/.next/standalone ./
COPY --from=build --chown=logsetu:logsetu /app/apps/server/.next/static ./apps/server/.next/static
COPY --from=build --chown=logsetu:logsetu /app/apps/server/prisma/migrations ./apps/server/prisma/migrations
COPY --from=build --chown=logsetu:logsetu /app/apps/server/scripts/migrate.mjs ./apps/server/scripts/migrate.mjs
COPY --chown=logsetu:logsetu docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /data && chown logsetu:logsetu /data

USER logsetu
VOLUME ["/data"]
EXPOSE 8686
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
