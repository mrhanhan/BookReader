# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@12.11.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/mobile/package.json ./apps/mobile/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY packages/reader-core/package.json ./packages/reader-core/
RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY packages/reader-core ./packages/reader-core
COPY apps/web ./apps/web
# API origin baked into the bundle at build time. Empty keeps the web build
# same-origin (Caddy proxies /api); native shells need an absolute URL.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @bookr/web build

# ---- runtime ---------------------------------------------------------------
FROM caddy:2-alpine AS runtime

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:80/ || exit 1
