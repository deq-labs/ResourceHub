# ResourceHub

A secure, multi-tenant resource portal: TypeScript end to end, NestJS on Fastify, React 19,
PostgreSQL Row-Level Security, BullMQ, REST + SOAP integrations, and Azure infrastructure as code.

> Status: under construction, phase by phase. See [`docs/spec.md`](docs/spec.md) for the build spec.

## Quick start

Requires Node 22+, pnpm, and Docker.

```bash
pnpm install
pnpm infra:up      # Postgres, Redis, Azurite, Mailpit, SOAP + REST mocks
pnpm turbo build lint typecheck test
```
