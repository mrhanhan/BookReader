# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@12.11.2

WORKDIR /app

# Workspace manifests first so the dependency layer is cached independently of
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
RUN pnpm install --frozen-lockfile

# Only the server and the shared package it bundles are needed here.
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN pnpm --filter @bookr/server build

# Drop dev dependencies (tsup, vitest, drizzle-kit) from the runtime tree.
RUN pnpm install --prod --frozen-lockfile

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
# Calibre provides `ebook-convert`; ca-certificates is required for HTTPS S3
# endpoints. The native modules (argon2, @napi-rs/canvas) ship prebuilt glibc
# binaries, so no compiler toolchain is needed at runtime.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends calibre ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 bookr \
  && useradd --uid 10001 --gid bookr --create-home --shell /usr/sbin/nologin bookr

COPY --from=build --chown=bookr:bookr /app /app

WORKDIR /app/apps/server
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/apps/server/drizzle \
    HOME=/home/bookr \
    QT_QPA_PLATFORM=offscreen
USER bookr

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
