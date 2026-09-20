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
# browser/ and public/ are inputs to the build too: `npm run build` also bundles the dashboard's
# Keplr helper into public/vendor/ (self-hosted rather than loaded from a CDN — see
# browser/deposit-entry.ts).
COPY browser ./browser
COPY public ./public
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# src/ and tsconfig.json are kept alongside the compiled dist/ (not just for building) so the
# calibrate:*/smoke:* scripts — meant to be run ad hoc via `docker exec` against a live
# deployment, not part of the request-serving path — work with `npm run <script>` as documented
# in DEPLOY.md, without needing a separate dev image.
COPY tsconfig.json ./
COPY src ./src

# Runs as the default node image's built-in "node" user, not root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
