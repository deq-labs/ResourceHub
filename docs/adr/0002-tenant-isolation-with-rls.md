# ADR 0002: Tenant isolation in three layers, enforced by Postgres RLS

- Status: accepted
- Date: 2026-11-10

## Context

ResourceHub uses one shared database with a `tenant_id` on every tenant-owned table. An app bug
(a forgotten `WHERE tenant_id = ?`) must not be able to leak data between tenants.

## Decision

Three layers. Each one has to fail on its own before data can leak.

1. **Host → tenant.** A Fastify `onRequest` hook maps `Host` to exactly one tenant
   (`{slug}.{ROOT_DOMAIN}` or a verified custom domain), cached in Redis for 300s. The
   `HostScopeGuard` returns 404 for unknown hosts before auth runs.
2. **Membership.** The auth guard rejects a token whose memberships don't include the
   resolved tenant (Phase 2).
3. **Row-Level Security.** Every request's DB work runs in `withTenantTx()`. That opens a
   transaction, runs `set_config('app.tenant_id', $1, true)` (`SET LOCAL` semantics), and lets
   policies on every table filter by `app_current_tenant()`.

**Roles.** `resourcehub_migrator` owns the tables. `resourcehub_app` is NOBYPASSRLS and owns
nothing. `resourcehub_platform` is BYPASSRLS, used only by audited platform code and the seed.
Every table uses `FORCE ROW LEVEL SECURITY`, so even the owner is filtered.

**Pre-tenant lookups.** Host resolution (and later, login) has to happen before a tenant is known.
Instead of giving the app role a bypass, these go through narrow `SECURITY DEFINER` functions owned
by the platform role (`app_resolve_tenant(slug, hostname)`). Each answers exactly one question.

**Pooled-connection gotcha.** After a `SET LOCAL` on a pooled connection, the GUC reads as `''`
in later transactions, not NULL. `app_current_tenant()` wraps it in `NULLIF(..., '')`, so a query
with no tenant set matches zero rows instead of erroring. A test covers this.

**Guardrails.** A CI job migrates a fresh database as the migrator and fails if any table lacks
RLS + FORCE + a policy, or if a tenant table has no index leading with `tenant_id`. ESLint bans
raw `pg` / drizzle imports in `apps/api/src/modules/**`. Cache keys for tenant data go through
`TenantScopedCache`, which refuses keys without a tenant id.

## Consequences

- Isolation holds even if application code forgets a filter, and it's tested at both the DB and
  the API level.
- Every unit of work is one short transaction. `SET LOCAL` keeps it safe with PgBouncer in
  transaction mode.
- Cross-tenant features (platform admin, seeding) must use the platform role explicitly, which
  makes them visible and auditable.
