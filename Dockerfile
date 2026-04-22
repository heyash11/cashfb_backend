# syntax=docker/dockerfile:1.7

# --- Builder: compile TypeScript ---
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN pnpm build

# --- Prod deps only (pruned) ---
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

# --- Runtime: distroless, non-root, no shell ---
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=builder   --chown=nonroot:nonroot /app/dist          ./dist
COPY --chown=nonroot:nonroot package.json ./

USER nonroot
EXPOSE 4000

CMD ["dist/server.js"]
