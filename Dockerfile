# Builds the React frontend and the Node control plane that serves it.
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY server/tsconfig.json ./server/
COPY src/ ./src/
COPY public/ ./public/
COPY server/src/ ./server/src/
RUN pnpm run build

# Production install for the control plane only. The pnpm workspace keeps the
# lockfile authoritative, so this resolves the same versions the build used.
FROM node:22-alpine AS runtime-deps
WORKDIR /deps
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
RUN pnpm install --prod --frozen-lockfile --filter @ship-it/website-server

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV FRONTEND_DIST=/app/public

# The workspace layout is preserved so Node resolves the control plane's
# dependencies from the same directory the build produced them in.
WORKDIR /app/server
COPY --from=runtime-deps /deps/node_modules /app/node_modules
COPY --from=runtime-deps /deps/server/node_modules ./node_modules
COPY --from=runtime-deps /deps/server/package.json ./package.json
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/dist /app/public

EXPOSE 3000
CMD ["node", "dist/index.js"]
