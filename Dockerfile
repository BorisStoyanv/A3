
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS app

ENV NODE_ENV=production
WORKDIR /app

ARG DFX_VERSION=0.26.1
ARG DFX_ARCH=x86_64

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git bash libunwind8 procps iproute2 python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/dfx.tar.gz https://github.com/dfinity/sdk/releases/download/${DFX_VERSION}/dfx-${DFX_VERSION}-${DFX_ARCH}-linux.tar.gz \
    && tar -xzf /tmp/dfx.tar.gz -C /usr/local/bin \
    && chmod +x /usr/local/bin/dfx \
    && rm -rf /tmp/dfx.tar.gz

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
ENV npm_config_python=/usr/bin/python3
RUN npm ci --omit=dev --workspace backend --registry=https://registry.npmjs.org
COPY backend ./backend
WORKDIR /app
COPY scripts ./scripts

RUN chown -R node:node /app
USER node
WORKDIR /app/backend

ENV PORT=3000 \
    ICP_NETWORK=local \
    DFX_IDENTITY=anonymous

EXPOSE 3000

CMD ["node", "src/server.js"]
