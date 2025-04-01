FROM node:lts-alpine

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV MCP_CONFIG_DIR=/home/node/.heimdall

# Create logging directory with proper ownership
RUN mkdir -p /home/node/.heimdall && \
    chown -R node:node /home/node/.heimdall && \
    chmod -R 755 /home/node/.heimdall

RUN npm install -g pnpm

COPY --chown=node:node ["./package.json", "./pnpm-lock.yaml", "./"]

RUN pnpm fetch
RUN pnpm install -r --offline

COPY --chown=node:node ["./src", "./tsconfig.json", "./"]

RUN pnpm run build

USER node

ENTRYPOINT ["pnpm", "run", "start"]
