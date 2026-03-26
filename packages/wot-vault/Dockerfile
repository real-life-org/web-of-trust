FROM node:22-slim AS build

# better-sqlite3 needs build tools for native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Minimal package.json for Docker (no workspace: refs)
RUN printf '{"name":"@web.of.trust/vault","version":"0.1.0","type":"module","private":true}\n' > package.json

# Install only what's needed for build + runtime
# wot-core dependencies (idb, @noble/ed25519, @scure/base, @scure/bip39) must be installed
# since wot-core-dist is copied directly without dependency resolution
RUN npm install better-sqlite3 typescript @types/better-sqlite3 \
    idb @noble/ed25519 @scure/base @scure/bip39 \
    @automerge/automerge @automerge/automerge-repo

# Copy wot-core pre-built bundle as local module
# This directory is committed to git (run: pnpm --filter wot-core build,
# then copy dist/ + package.json into wot-core-dist/)
COPY wot-core-dist/ node_modules/@web.of.trust/core/

# Copy source + standalone tsconfig (no monorepo extends)
COPY src/ src/
COPY tsconfig.docker.json tsconfig.json
RUN npx tsc

# --- Production stage ---
FROM node:22-slim

WORKDIR /app

COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json .

ENV PORT=8789
ENV DB_PATH=/data/vault.db

EXPOSE 8789

VOLUME ["/data"]

CMD ["node", "dist/start.js"]
