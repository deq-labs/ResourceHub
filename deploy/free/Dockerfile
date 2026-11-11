# syntax=docker/dockerfile:1.7
# Free-tier image: API + worker in one container (see start.mjs). Azure uses the two separate
# images in apps/api and apps/worker instead.
# Build context: repository root.  docker build -f deploy/free/Dockerfile -t resourcehub-free .

ARG NODE_IMAGE=node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.16.1 --no-fund --no-audit
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@resourcehub/api..." --filter "@resourcehub/worker..."
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm --filter "@resourcehub/api..." --filter "@resourcehub/worker..." run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --filter @resourcehub/api --prod --legacy /out/api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --filter @resourcehub/worker --prod --legacy /out/worker

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=10000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node deploy/free/start.mjs ./start.mjs
USER node
EXPOSE 10000
CMD ["node", "start.mjs"]
