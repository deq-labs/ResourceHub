# syntax=docker/dockerfile:1.7
# ResourceHub API. The same image runs DB migrations as a Container Apps Job:
#   node node_modules/@resourcehub/db/dist/cli.js migrate
# Build context: repository root.  docker build -f apps/api/Dockerfile -t resourcehub-api .

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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@resourcehub/api..."
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter "@resourcehub/api..." run build
# Self-contained production bundle: the api + its workspace deps + prod node_modules only.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --filter @resourcehub/api --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
