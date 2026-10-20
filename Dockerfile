# Builds the Go edge: streaming upload ingest + reverse proxy in one static
# binary. Stdlib only, so this stage needs no module downloads.
FROM golang:1.26-alpine AS edge-builder
WORKDIR /src
COPY edge/go.mod ./
COPY edge/ ./
RUN CGO_ENABLED=0 go build -o /out/edge ./cmd/edge

# Builds the React frontend and the Node control plane that serves it.
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
# The manual is a workspace package of its own: its manifest has to exist
# before the install, or pnpm cannot resolve the workspace.
COPY docs/package.json ./docs/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY server/tsconfig.json ./server/
COPY src/ ./src/
COPY public/ ./public/
COPY server/src/ ./server/src/
COPY docs/docusaurus.config.ts docs/sidebars.ts ./docs/
COPY docs/docs/ ./docs/docs/
COPY docs/src/ ./docs/src/
RUN pnpm run build

# Production install for the control plane only. The pnpm workspace keeps the
# lockfile authoritative, so this resolves the same versions the build used.
FROM node:22-alpine AS runtime-deps
WORKDIR /deps
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY docs/package.json ./docs/
RUN pnpm install --prod --frozen-lockfile --filter @ship-it/website-server

FROM node:22-alpine
ENV NODE_ENV=production
# PORT is the public port, owned by the edge. Render injects its own value;
# Node moves to NODE_PORT on loopback so the two never collide in one container.
ENV PORT=3000
ENV NODE_PORT=3001
ENV HOST=0.0.0.0
ENV FRONTEND_DIST=/app/public
ENV NODE_ENTRY=dist/index.js

# The workspace layout is preserved so Node resolves the control plane's
# dependencies from the same directory the build produced them in.
WORKDIR /app/server
COPY --from=runtime-deps /deps/node_modules /app/node_modules
COPY --from=runtime-deps /deps/server/node_modules ./node_modules
COPY --from=runtime-deps /deps/server/package.json ./package.json
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/dist /app/public
COPY --from=edge-builder /out/edge /usr/local/bin/edge

EXPOSE 3000
# The edge is PID 1: it serves the public port, streams the two large-body
# uploads straight to storage, proxies everything else to Node on loopback,
# and supervises the Node child (with a capped V8 heap). /health still answers
# from Node through the proxy, so platform health checks are unchanged.
CMD ["/usr/local/bin/edge"]
