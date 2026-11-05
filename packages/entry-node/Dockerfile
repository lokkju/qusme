# The qus.me service on Node. Build from the repository root:
#   docker build -f packages/entry-node/Dockerfile --build-arg QUSME_VERSION=$(git rev-parse --short HEAD) .
# Run with QUSME_AGENT_KEY_SECRET set and a volume at /data for the SQLite file.
FROM node:24.22.1-bookworm-slim

ENV PNPM_VERSION=12.15.0
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/nostr/package.json packages/nostr/
COPY packages/store-sql/package.json packages/store-sql/
COPY packages/entry-node/package.json packages/entry-node/
RUN pnpm install --frozen-lockfile --prod --filter @qusme/entry-node...

COPY packages/core packages/core
COPY packages/nostr packages/nostr
COPY packages/store-sql packages/store-sql
COPY packages/entry-node packages/entry-node
COPY registry registry

ARG QUSME_VERSION=dev
ENV QUSME_VERSION=${QUSME_VERSION} \
    QUSME_DB_PATH=/data/qusme.db \
    PORT=8787 \
    NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "packages/entry-node/src/server.ts"]
