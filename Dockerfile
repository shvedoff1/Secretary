# --- Builder: install deps (incl. native build for better-sqlite3) and compile ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build tools for better-sqlite3 (falls back to prebuilt when available).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime: slim image with compiled output and prod deps only ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Persist the SQLite database here.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data
USER node

CMD ["node", "dist/index.js"]
