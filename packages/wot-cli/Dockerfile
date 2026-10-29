FROM node:22-slim

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /app

# Copy everything (monorepo)
COPY . .

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Build wot-core and adapter-yjs (dependencies of wot-cli)
RUN pnpm --filter @web_of_trust/core build && \
    pnpm --filter @web_of_trust/adapter-yjs build

# Data directory for SQLite + encrypted seed
RUN mkdir -p /app/packages/wot-cli/data && chmod 700 /app/packages/wot-cli/data

EXPOSE 8790

WORKDIR /app/packages/wot-cli

CMD ["npx", "tsx", "src/start.ts"]
