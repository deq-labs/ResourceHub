# syntax=docker/dockerfile:1.7
# ResourceHub worker (BullMQ consumers). Build context: repository root.

ARG NODE_IMAGE=node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.16.1 --no-fund --no-audit
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@resourcehub/worker..."
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter "@resourcehub/worker..." run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --filter @resourcehub/worker --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
