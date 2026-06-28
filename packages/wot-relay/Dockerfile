FROM node:22-slim AS build

# better-sqlite3 needs build tools for native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Build context for this Dockerfile is the repository root, so the image can
# build packages/wot-core/ directly from the workspace source (relay imports
# { protocol, WebCryptoProtocolCryptoAdapter } from @web_of_trust/core).

# --- Build @web_of_trust/core from workspace source ---
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/wot-core/ packages/wot-core/
WORKDIR /repo/packages/wot-core
RUN rm -rf node_modules dist \
 && npm install --no-save --legacy-peer-deps \
 && npm run build

# --- Relay build stage ---
WORKDIR /app

# Minimal package.json for Docker (no workspace: refs)
RUN printf '{"name":"@web_of_trust/relay","version":"0.1.0","type":"module","private":true}\n' > package.json

# Install relay deps + wot-core runtime deps (wot-core is dropped in below
# without workspace dependency resolution, so its transitive deps must exist here).
RUN npm install ws better-sqlite3 typescript @types/ws @types/better-sqlite3 \
    idb @noble/ed25519 @scure/base @scure/bip39 \
    @automerge/automerge @automerge/automerge-repo

# Drop the freshly built @web_of_trust/core into node_modules
RUN mkdir -p node_modules/@web_of_trust/core \
 && cp -R /repo/packages/wot-core/dist node_modules/@web_of_trust/core/dist \
 && cp /repo/packages/wot-core/package.json node_modules/@web_of_trust/core/package.json

# Copy relay source + standalone tsconfig (no monorepo extends)
COPY packages/wot-relay/src/ src/
COPY packages/wot-relay/tsconfig.docker.json tsconfig.json
RUN npx tsc

# --- Production stage ---
FROM node:22-slim

WORKDIR /app

COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json .

ENV PORT=8787
ENV DB_PATH=/data/relay-queue.db

EXPOSE 8787

VOLUME ["/data"]

CMD ["node", "dist/start.js"]
