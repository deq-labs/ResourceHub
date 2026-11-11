# ADR 0001: pnpm + Turborepo monorepo, ESM everywhere, pinned major versions

- Status: accepted
- Date: 2026-11-10

## Context

The spec asks for one pnpm monorepo, strict TypeScript and Node 22 LTS, with NestJS 11 on Fastify.
At build time several dependencies had moved one major ahead of the spec (NestJS 12, TypeScript 7,
Vite 8, Vitest 5, ESLint 10). `nestjs-zod` still declares peers on NestJS 11 and Swagger 11.

## Decision

- **Workspace:** pnpm workspaces + Turborepo. Each package builds to `dist/` with `tsc`, and
  `build` depends on `^build`.
- **ESM only:** `"type": "module"` with `module: NodeNext`. Relative imports carry a `.js` extension.
- **Pinned majors:** NestJS 11, TypeScript 5.9, Vite 7, Vitest 3, ESLint 9, ioredis 5, BullMQ 5.
  These are the versions the spec names and the versions whose peer ranges agree with each other.
- **Tests:** Vitest uses `unplugin-swc` so decorator metadata (needed by Nest DI) is emitted.
  API tests use Fastify's `inject()`, the Fastify-native equivalent of Supertest.
- **Ports:** local Postgres runs on host port 55432 so it doesn't clash with a locally installed
  Postgres on 5432.

## Consequences

- Upgrading to Nest 12 / TS 7 is a deliberate, separate task once the ecosystem catches up.
- `.js` extensions in TS source look odd to newcomers, but they're what Node ESM resolution needs.
