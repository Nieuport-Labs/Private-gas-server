# Multi-stage build — better-sqlite3 needs native compilation (node-gyp), which the slim
# runtime image shouldn't carry around after the build is done.

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

# Runs as the default node image's built-in "node" user, not root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
