FROM node:22-slim AS build

# better-sqlite3 needs build tools for native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Build context for this Dockerfile is the repository root, so the image can
# build packages/wot-core/ directly from the workspace source.

# --- Build @web_of_trust/core from workspace source ---
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/wot-core/ packages/wot-core/
WORKDIR /repo/packages/wot-core
RUN rm -rf node_modules dist \
 && npm install --no-save --legacy-peer-deps \
 && npm run build

# --- Vault build stage ---
WORKDIR /app

# Minimal package.json for Docker (no workspace: refs)
RUN printf '{"name":"@web_of_trust/vault","version":"0.1.0","type":"module","private":true}\n' > package.json

# Install only what's needed for build + runtime.
# wot-core runtime dependencies (idb, @noble/ed25519, @scure/base, @scure/bip39)
# must be installed because we drop in @web_of_trust/core as a local module
# without going through workspace dependency resolution.
RUN npm install better-sqlite3 typescript @types/better-sqlite3 \
    idb @noble/ed25519 @scure/base @scure/bip39 \
    @automerge/automerge @automerge/automerge-repo

# Drop the freshly built @web_of_trust/core into node_modules
RUN mkdir -p node_modules/@web_of_trust/core \
 && cp -R /repo/packages/wot-core/dist node_modules/@web_of_trust/core/dist \
 && cp /repo/packages/wot-core/package.json node_modules/@web_of_trust/core/package.json

# Copy Vault source + standalone tsconfig (no monorepo extends)
COPY packages/wot-vault/src/ src/
COPY packages/wot-vault/tsconfig.docker.json tsconfig.json
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
