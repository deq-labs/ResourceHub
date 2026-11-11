# Multi-Tenant Portal — Agentic Build Spec

Nov 10, 2026 · @Joe

## Overview and goals

Rebuild HubKit (Laravel 12 + Filament + React 19) as **HubKit TS**, a full port to TypeScript, React, Node.js, PostgreSQL and Azure. Every feature in the job posting should show up in it. Agents do most of the typing; this doc is the source of truth they build from.

What carries over unchanged: shared-database tenancy, subdomain/custom-domain resolution, per-tenant branding, the resource hub domain model, and the React UI patterns.

What changes: the backend (Laravel → NestJS), the admin panel (Filament → React admin pages), tenant scoping (Eloquent scopes → Postgres Row-Level Security), and hosting (Railway → Azure).

**Done means:**

- [ ] Feature parity with HubKit's tenant-facing hub and admin panel
- [ ] A test suite that proves tenant A cannot read or write tenant B's data, at the API and at the database level
- [ ] One working REST integration and one working SOAP integration behind adapters
- [ ] Deployed to Azure from GitHub Actions, with infrastructure as code (Terraform)
- [ ] A README and an architecture page good enough to walk an interviewer through in 10 minutes

## Key decisions

The posting lists Node.js, not Next.js, so the backend is a standalone Node API and the frontend is a separate React app. That split also suits a portal that will talk to outside systems.

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Frontend framework | React 19 + Vite SPA, TanStack Router + TanStack Query | Matches the posting; a clean split between API and UI; reuses your HubKit React code | Next.js: adds server rendering a logged-in portal doesn't need, and blurs where the Node backend ends |
| Backend framework | NestJS 11 on Fastify | Closest to Laravel (modules, DI, guards, pipes); a structure agents follow reliably | Plain Express: you'd hand-build the structure Laravel gave you |
| Your own API | REST + OpenAPI 3.1, generated from Zod schemas | The default for new APIs; a generated typed client for the SPA | SOAP for your own API: legacy; nobody builds new APIs with it |
| Outside integrations | REST and SOAP **clients** behind one adapter interface | The client likely has legacy partners (EHR, insurance, ERP) that only speak SOAP; you consume it, you don't serve it | Letting XML leak into domain code |
| Tenancy model | Shared database, `tenant_id` on every tenant table, Postgres RLS | Same as HubKit; cheapest to run; RLS makes isolation a database guarantee | Schema per tenant (painful migrations); database per tenant (cost, ops) |
| ORM / queries | Drizzle ORM + drizzle-kit migrations | Close to SQL; easy to write RLS policies and `SET LOCAL` in migrations | Prisma: RLS and per-transaction settings are awkward |
| Validation | Zod, shared between API and SPA | One schema drives validation, types and OpenAPI | class-validator: duplicates types |
| Auth | Microsoft Entra External ID (OIDC) for users; local JWT sessions in the API | Azure-native; supports per-tenant identity providers later | Rolling your own password auth |
| Jobs and queues | BullMQ on Azure Cache for Redis | Same role as Laravel queues; retries and scheduling built in | Azure Service Bus: revisit if they mandate it |
| Monorepo | pnpm workspaces + Turborepo | Shared types/schemas across apps; agents can run tasks per package | Separate repos |

## Stack and repo layout

One pnpm monorepo, strict TypeScript everywhere, Node 22 LTS.

| Layer | Tool | Laravel/HubKit equivalent |
| --- | --- | --- |
| UI | React 19, Vite, TanStack Router/Query, Tailwind v4, shadcn/ui | React 19 frontend |
| Admin | React admin routes in the same SPA (role-gated) | Filament v5 |
| API | NestJS 11 (Fastify adapter), Zod, nestjs-zod, @nestjs/swagger | Laravel controllers, form requests |
| Data | PostgreSQL 16, Drizzle ORM, drizzle-kit | Eloquent, migrations |
| Jobs | BullMQ + Redis | Laravel queues + Horizon |
| Auth | Entra External ID (OIDC), jose for JWTs | Sanctum / Breeze |
| SOAP | `soap` npm package | (none) |
| Tests | Vitest, Supertest, Testcontainers (real Postgres), Playwright | PHPUnit/Pest, Dusk |
| Lint/format | ESLint (typescript-eslint strict), Prettier | Pint |
| Infra | Terraform (azurerm), Docker, GitHub Actions | Railway |
| Observability | pino logs, OpenTelemetry → Azure Monitor / App Insights | Laravel logs |

```
hubkit-ts/
├─ apps/
│  ├─ api/            # NestJS service
│  │  └─ src/modules/{tenants,auth,users,resources,branding,integrations,audit}
│  ├─ web/            # React SPA (tenant hub + admin)
│  └─ worker/         # BullMQ consumers (sync jobs, emails)
├─ packages/
│  ├─ db/             # Drizzle schema, migrations, RLS policies, seed
│  ├─ contracts/      # Zod schemas + generated OpenAPI client
│  ├─ integrations/   # adapter interface, REST + SOAP clients, mocks
│  └─ config/         # eslint, tsconfig, prettier presets
├─ infra/terraform/   # Azure resources, per-environment
├─ docs/              # ADRs, architecture, runbooks
├─ CLAUDE.md          # agent rules (see Agentic workflow)
└─ docker-compose.yml # local Postgres, Redis, SOAP mock
```

## Multi-tenancy and data separation

Tenant isolation has three layers, and each one has to fail on its own before data can leak: the request resolves one tenant, the auth guard checks the user belongs to it, and Postgres RLS filters every row by it.

**1. Resolve the tenant.** Fastify middleware reads the `Host` header. It matches `{slug}.hubkit.app` or a verified custom domain from `tenant_domains` (cached in Redis for 5 minutes). An unknown host returns 404 before any auth runs.

**2. Check membership.** The JWT carries `sub` and the user's tenant memberships. A NestJS guard rejects the request with 403 unless the user is a member of the resolved tenant. Platform super-admins use a separate admin host, never a tenant subdomain.

**3. Enforce it in the database.** Each request runs inside one transaction that starts with `SET LOCAL app.tenant_id = '<uuid>'`. The context lives in AsyncLocalStorage, so services never pass `tenantId` around by hand.

```sql
-- every tenant table
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resources
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**Database roles.**

- `hubkit_migrator`: owns the tables; used only by drizzle-kit in CI.
- `hubkit_app`: the API's role. It has `NOBYPASSRLS` and does not own the tables, so RLS always applies to it.
- `hubkit_platform`: a separate role with `BYPASSRLS`, used only by the platform-admin module and cross-tenant jobs. Every use is written to the audit log.

**Rules agents must follow.**

- Every new tenant-owned table gets `tenant_id uuid not null references tenants(id)`, an index that leads with `tenant_id`, and the RLS policy above, in the same migration.
- Never query outside `withTenantTx()`. A lint rule bans importing the raw db client in `apps/api/src/modules/**`.
- Background jobs carry `tenantId` in the payload and open their own `withTenantTx()`.
- File storage paths are prefixed with `tenants/{tenantId}/`; the API only issues SAS URLs scoped to that prefix.

**Isolation tests (they gate merging).**

- [ ] A CI check fails if any table with a `tenant_id` column lacks RLS + FORCE + a policy
- [ ] Seed tenants A and B; for every endpoint, A's token on A's host can't see, change or count B's rows
- [ ] A's token on B's host returns 403
- [ ] A raw query as `hubkit_app` without `app.tenant_id` set returns zero rows
- [ ] A cache key must include the tenant id (checked by a unit test on the cache wrapper)

## Data model

The first agent task is to read HubKit's Laravel migrations and models and turn them into Drizzle tables. The list below is the starting set and gets corrected against that source. All ids are UUID v7, all timestamps `timestamptz`, and every table has `created_at` / `updated_at`.

| Table | Tenant-scoped | Key columns | Notes |
| --- | --- | --- | --- |
| `tenants` | No (platform) | slug, name, status, plan | Root of everything |
| `tenant_domains` | Yes | hostname, verified\_at, is\_primary | Custom domains; verified by a DNS TXT record |
| `tenant_branding` | Yes | logo\_url, colors (jsonb), fonts, favicon\_url | The theme tokens the SPA loads at boot |
| `users` | No (global identity) | entra\_oid, email, name | One person can belong to many tenants |
| `memberships` | Yes | user\_id, role (owner, admin, editor, viewer) | Unique on (tenant\_id, user\_id) |
| `invitations` | Yes | email, role, token\_hash, expires\_at | Single-use |
| `resources` | Yes | title, slug, body (jsonb), status, published\_at, category\_id | The hub's core content |
| `categories` / `tags` / `resource_tags` | Yes | name, slug, sort | Taxonomy |
| `files` | Yes | blob\_path, mime, size, checksum | Blob paths start with `tenants/{id}/` |
| `integrations` | Yes | kind (rest, soap), provider, config (jsonb), secret\_ref | `secret_ref` points to Key Vault, never the secret |
| `integration_runs` | Yes | integration\_id, status, started\_at, error | Sync history |
| `audit_log` | Yes | actor\_id, action, entity, entity\_id, diff (jsonb), ip | Append-only; the app role has INSERT only |

## API and integrations

The portal exposes only REST. SOAP shows up only on the outbound side, inside one adapter package, so the rest of the code never sees XML or WSDL.

**REST conventions.**

- Base path `/api/v1`, with the tenant implied by the host (never in the URL)
- Resource nouns, plural: `GET /resources`, `POST /resources`, `PATCH /resources/:id`
- Cursor pagination (`?cursor=&limit=`, max 100), filtering by `?filter[status]=published`
- Errors use RFC 9457 Problem Details: `{type, title, status, detail, traceId}`
- An `Idempotency-Key` header on every POST that creates something or triggers a sync
- The OpenAPI spec is generated at build time; `packages/contracts` generates a typed client for the SPA

**Integration adapter.** Every outside system implements one interface:

```ts
export interface IntegrationAdapter<TConfig, TRecord> {
  readonly kind: 'rest' | 'soap';
  testConnection(cfg: TConfig): Promise<Result<void, IntegrationError>>;
  fetchChanges(cfg: TConfig, since: Date): AsyncIterable<TRecord>;
  push(cfg: TConfig, record: TRecord): Promise<Result<string, IntegrationError>>;
}
```

- **SOAP client:** the `soap` package builds a client from the WSDL, and the WSDL file is committed. Map XML to a Zod-validated domain type at the edge. Support WS-Security UsernameToken and client-certificate auth (certificate stored in Key Vault).
- **REST client:** `undici` fetch with timeouts, retry with jittered backoff on 429/5xx, and a circuit breaker per integration.
- **Runs:** syncs run as BullMQ jobs (never inside a request); each writes an `integration_runs` row and a trace span.
- **Local dev:** docker-compose runs a SOAP mock server built from a sample WSDL, plus a WireMock REST mock. Contract tests replay recorded fixtures.
- **Demo integrations:** one public SOAP service (for example a free country-info or calculator WSDL) and one REST API, so the demo works without client access.

## Security baseline

"Secure portal" is the first word in the posting, so security gets built from day one, not added at the end. The baseline follows the OWASP ASVS Level 2 items that fit a portal like this.

- **Auth:** OIDC with PKCE through Entra External ID. The API issues a short-lived access JWT (15 min) plus a rotating refresh token in an `HttpOnly; Secure; SameSite=Lax` cookie. Tokens never go in localStorage.
- **Authorization:** role-based guards per route (`@Roles('admin')`), plus per-record checks in services. Deny by default.
- **Secrets:** all in Azure Key Vault, read through managed identity. No connection strings in env files in Azure.
- **Transport and headers:** TLS only, HSTS, a strict CSP (a tenant's custom fonts and logos come from an allowlisted CDN), `@fastify/helmet`.
- **Input:** Zod on every request body, query and param. Parameterized SQL only (Drizzle). Rich-text bodies sanitized with DOMPurify on render.
- **Abuse:** rate limits per IP and per tenant (`@fastify/rate-limit`, backed by Redis); lockout after repeated failed invites.
- **Data:** Postgres encrypted at rest (Azure default); PII columns listed in `docs/data-inventory.md`; audit log for every admin action and every cross-tenant platform action.
- **Supply chain:** Dependabot, `pnpm audit` and CodeQL in CI; Trivy scans the container images; pinned base images.
- **Compliance hooks:** keep it HIPAA/SOC 2-friendly (audit trail, access reviews, log retention) without claiming certification. Ask the client which regime applies.

## Azure infrastructure and CI/CD

Everything is defined in Terraform, with two environments (`dev`, `prod`) in separate resource groups. Pick the smallest SKUs for the demo and tear dev down when you're not using it, so the monthly bill stays low.

| Resource | Azure service | Purpose |
| --- | --- | --- |
| API + worker | Azure Container Apps (two apps, one environment) | Scales to zero; wildcard custom domain + managed certs |
| SPA | Azure Static Web Apps (or Front Door + Blob) | Serves the React build |
| Database | Azure Database for PostgreSQL Flexible Server | Private endpoint; Entra auth for admins |
| Cache/queue | Azure Cache for Redis (Basic) | BullMQ, tenant host cache, rate limits |
| Files | Blob Storage | Per-tenant prefixes, SAS URLs |
| Secrets | Key Vault | Read by managed identity |
| Images | Azure Container Registry | API and worker images |
| Edge | Azure Front Door | Wildcard `*.hubkit.app`, WAF, custom tenant domains |
| Observability | Log Analytics + Application Insights | OpenTelemetry traces, logs, alerts |
| Identity | Entra External ID tenant | User sign-in |

**GitHub Actions pipeline.**

1. On every PR: install, lint, typecheck, unit tests, integration tests against Testcontainers Postgres, the RLS coverage check, and a Playwright smoke test.
2. On merge to `main`: build images, run a Trivy scan, push to ACR, run `terraform plan`, run migrations as `hubkit_migrator`, deploy to `dev`.
3. On a release tag: a manual approval gate, then the same artifacts deploy to `prod`.
4. Azure login uses OIDC federated credentials, with no stored service principal secrets.

Azure DevOps Pipelines is the fallback if the client uses it; the steps are the same.

## Build phases

Eight phases, done in order; each one ends with something that runs. Phases 0–3 are the interview-ready slice, so stop there if the interview is soon. The total is 1,000 XP, and you level up at 250 / 500 / 750 / 1,000.

### Phase 0 — Foundation (50 XP)

- [ ] Monorepo, strict tsconfig, ESLint/Prettier, Turborepo tasks, CLAUDE.md
- [ ] docker-compose with Postgres 16, Redis, SOAP mock
- [ ] CI runs lint + typecheck + an empty test suite and passes

### Phase 1 — Tenancy core (150 XP)

- [ ] Drizzle schema for `tenants`, `tenant_domains`, `users`, `memberships`
- [ ] The three database roles, RLS policies, `withTenantTx()`, AsyncLocalStorage context
- [ ] Host-based tenant resolution middleware with a Redis cache
- [ ] The isolation test suite and the RLS coverage CI check, both passing

### Phase 2 — Auth and roles (125 XP)

- [ ] Entra External ID sign-in (OIDC + PKCE), JWT access + refresh-cookie flow
- [ ] Membership guard, role guard, invitations
- [ ] Audit log writes for auth and admin events

### Phase 3 — Hub port (175 XP)

- [ ] Resources, categories, tags, files: API + SPA, ported from HubKit's features
- [ ] Per-tenant branding loaded at boot (CSS variables), plus custom-domain verification
- [ ] Generated OpenAPI client used by the SPA

### Phase 4 — Admin panel (100 XP)

- [ ] Tenant admin: users, roles, branding, domains, audit log viewer
- [ ] Platform admin on its own host: create/suspend tenants, impersonation with an audit trail

### Phase 5 — Integrations (150 XP)

- [ ] Adapter interface, the REST client, the SOAP client with WS-Security
- [ ] BullMQ worker, `integration_runs`, retries, circuit breaker
- [ ] Two demo integrations (one SOAP, one REST) plus contract tests

### Phase 6 — Azure (150 XP)

- [ ] Terraform for every resource in the infrastructure table
- [ ] GitHub Actions deploying to dev on merge and to prod on tag, using OIDC
- [ ] Front Door wildcard domain; two demo tenants live on subdomains

### Phase 7 — Harden and present (100 XP)

- [ ] OpenTelemetry traces in App Insights, plus alerts
- [ ] A security pass against the baseline; a load test with k6 for two tenants
- [ ] README, architecture diagram, ADRs, a 3-minute demo video

## Agentic workflow

Agents write the code; you own the architecture, review every PR, and are the only one who merges. One task per branch, one branch per PR, and every PR has to pass CI before you look at it.

**Agent roles.**

| Role | Does | Never does |
| --- | --- | --- |
| Planner | Breaks a phase into tasks using the task template; writes ADRs | Writes code |
| Builder | Implements one task with its tests, on a feature branch | Touches RLS policies, roles or CI without an ADR |
| Reviewer (fresh context) | Reviews the diff against this doc and the isolation rules; tries to break tenancy | Fixes code itself; it reports findings |
| Tester | Adds isolation, contract and Playwright tests for the phase | Weakens or skips an existing test |

**Task template** (`docs/tasks/P1-03-tenant-resolver.md`):

```markdown
# P1-03 Tenant resolver middleware
Goal: resolve tenant from Host header before auth.
Inputs: tenant_domains table, Redis.
Acceptance:
- unknown host -> 404 problem+json
- custom domain resolves after verification only
- cache key includes hostname; TTL 300s
Tests: unit + integration (Testcontainers).
Out of scope: auth, branding.
```

**CLAUDE.md** (repo root, the agents' rules):

```markdown
# HubKit TS — agent rules
- Read docs/spec.md (this document) before any task.
- TypeScript strict; no `any`, no `@ts-ignore` without a comment.
- All DB access via withTenantTx(); never import the raw client in modules.
- New tenant table = tenant_id + index + RLS policy in the SAME migration.
- Validate all input with Zod schemas from packages/contracts.
- No secrets in code or .env committed; use Key Vault refs.
- Every task ships tests; run `pnpm turbo test lint typecheck` before done.
- Never edit or skip tests in tests/isolation/ to make them pass.
- Ask before adding a dependency; prefer ones already in the stack.
- Commit messages: Conventional Commits.
```

**Guardrails.**

- Branch protection on `main`: CI required, plus your review; agents can't push to `main`.
- `tests/isolation/` and `packages/db/policies/` are in CODEOWNERS (you), so agent PRs that touch them get flagged.
- Agents run against local docker-compose only; production Azure credentials never go to an agent session.
- After each phase, a reviewer agent with fresh context reads the whole phase diff before you tag it.

## Interview talking points and risks

Lead with how you isolate tenants; it's the part they care about most and where you're strongest.

**Talking points.**

- "Isolation is enforced by the database, not just the app. RLS with FORCE, a non-owner app role, and CI that fails if a tenant table has no policy."
- "I've built this model before in Laravel (HubKit). This is the same design, ported to TypeScript and Azure."
- "SOAP stays at the edge. One adapter interface, WSDL-generated clients, typed mapping, mocked in CI."
- "Five years building enterprise multi-client portals in pharma, so audit trails and data handling are habits, not extras."
- "I own it end-to-end: Terraform, GitHub Actions with OIDC, observability, and the runbooks."

**Risks and how to handle them.**

| Risk | Mitigation |
| --- | --- |
| Node in production is newer to you than Laravel | Phase 7 load test + error-handling review; be ready to explain the event loop, pooling (pg max connections per replica), graceful shutdown |
| RLS performance at scale | `tenant_id`-leading indexes; check `EXPLAIN` plans in the load test |
| Connection pooling vs `SET LOCAL` | Use `SET LOCAL` inside transactions only (safe with PgBouncer in transaction mode) |
| Agent-written code you can't explain | Review every PR; rewrite anything you couldn't defend line by line |
| Azure cost | Smallest SKUs, scale to zero, destroy dev when idle |
| Contract length (3–4 months, W2, no benefits mentioned) | Ask about the chance of extension, conversion to full-time, and benefits before leaving EPG |

**Questions for the recruiter.**

- [ ] Who is the client, and what industry?
- [ ] Which systems need SOAP integration, and is there a WSDL I can see?
- [ ] Is there a compliance regime (HIPAA, SOC 2, FedRAMP)?
- [ ] Azure DevOps or GitHub? Existing Entra tenant?
- [ ] Team size: am I the only engineer?
