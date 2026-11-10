# ResourceHub — agent rules

- Read `docs/spec.md` (the build spec; "HubKit TS" there is this project) and `docs/architecture.md` before any task.
- TypeScript strict; no `any`, no `@ts-ignore` without a comment.
- All DB access via `withTenantTx()` / `withPlatformTx()` from `DbService`; never import the raw client in `apps/api/src/modules/**` (ESLint enforces this).
- New tenant table = `tenant_id` + index leading with `tenant_id` + RLS policy (ENABLE + FORCE) in the SAME migration.
- Validate all input with Zod schemas from `packages/contracts`.
- No secrets in code or committed `.env`; in Azure use Key Vault references.
- Every task ships tests; run `pnpm turbo build lint typecheck test` before done.
- Never edit or skip tests in `apps/api/test/isolation/` to make them pass.
- Ask before adding a dependency; prefer ones already in the stack.
- Commit messages: Conventional Commits.

## Local dev

- `pnpm infra:up` starts Postgres (host port 55432), Redis, Azurite, Mailpit, and the SOAP/REST mocks.
- ESM everywhere: relative imports in Node packages need the `.js` extension.
- Integration tests use Testcontainers, so Docker must be running.
