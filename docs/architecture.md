# Architecture

ResourceHub is one database shared by every tenant, guarded by three independent layers of
isolation. Behind it are a stateless API, a queue-driven worker, and a single SPA that becomes a
tenant hub, a workspace admin or a platform console depending on the hostname.

Diagrams are Mermaid and render on GitHub. Why each decision was made is in [`adr/`](adr).

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser
    SPA["React 19 SPA<br/>tenant hub · workspace admin · platform console"]
  end

  subgraph Edge["Edge (Azure Front Door + WAF)"]
    FD["*.resourcehub host<br/>custom tenant domains<br/>CSP, HSTS, rate rule"]
  end

  subgraph Compute["Azure Container Apps (VNet)"]
    API["API<br/>NestJS 11 on Fastify"]
    WRK["Worker<br/>BullMQ consumers"]
  end

  subgraph Data["Private data plane"]
    PG[("PostgreSQL 16<br/>RLS on every tenant table")]
    RD[("Redis<br/>queues · host cache · rate limits")]
    BL[("Blob Storage<br/>tenants/{id}/…")]
    KV["Key Vault<br/>secrets via managed identity"]
  end

  IDP["Entra External ID<br/>(OIDC + PKCE)"]
  EXT["Partner systems<br/>REST + SOAP"]
  AI["Application Insights<br/>traces · logs · alerts"]

  SPA -->|HTTPS| FD --> API
  FD -->|static files| SPA
  SPA -.->|sign-in redirect| IDP
  API --> PG
  API --> RD
  API -->|user-delegation SAS| BL
  API -->|enqueue sync / email| RD
  RD --> WRK
  WRK --> PG
  WRK -->|SSRF-guarded egress| EXT
  API -. OpenTelemetry .-> AI
  WRK -. OpenTelemetry .-> AI
  API --> KV
  WRK --> KV
```

| Piece            | Responsibility                                                                                                                 | Code                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| **API**          | Resolves the tenant from the host, authenticates, authorises, and runs every query inside a tenant-pinned transaction          | `apps/api`              |
| **Worker**       | Integration syncs (REST/SOAP) and outgoing email, outside the request path. Each job carries its `tenantId` and runs under RLS | `apps/worker`           |
| **SPA**          | One build. The host decides the experience: `{tenant}.…` is the hub plus admin, `admin.…` is the platform console              | `apps/web`              |
| **db**           | Drizzle schema, SQL migrations that create RLS policies, the three Postgres roles, seed                                        | `packages/db`           |
| **contracts**    | Zod schemas shared by both sides. They produce request validation, OpenAPI 3.1 and the SPA's typed client                      | `packages/contracts`    |
| **integrations** | One adapter interface; REST and SOAP clients with retry, a circuit breaker and an SSRF guard                                   | `packages/integrations` |

## 2. Life of a request

Everything tenant-specific comes from the **Host header**. The URL never contains a tenant id, so
there is nothing for a user to tamper with.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (contoso.localhost)
  participant F as Fastify onRequest
  participant R as TenantResolver (Redis 5 min)
  participant G as AuthGuard + RolesGuard
  participant I as TenantContext (AsyncLocalStorage)
  participant S as Service
  participant P as Postgres (role resourcehub_app)

  B->>F: GET /api/v1/resources  Host: contoso.localhost  Bearer JWT
  F->>R: resolve(host)
  R-->>F: tenant contoso (or 404 before any auth)
  F->>G: request + tenant
  G->>G: JWT valid? token tid == contoso? member? role ≥ required?
  G-->>B: 401 / 403 problem+json if not
  G->>I: store tenant id for this request
  I->>S: handler runs
  S->>P: BEGIN, then set_config('app.tenant_id', contoso, true)
  S->>P: SELECT … FROM resources   (no WHERE tenant_id needed)
  P-->>S: only Contoso rows (RLS policy)
  S->>P: COMMIT (setting disappears with the transaction)
  S-->>B: 200 JSON + x-request-id + trace id
```

| Step                                                           | Where                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Host → tenant, unknown host → 404                              | `apps/api/src/modules/tenants/tenant-resolver.service.ts`, hook in `apps/api/src/app.factory.ts` |
| Token checks (`tid` must match host, `ctx` tenant vs platform) | `apps/api/src/common/auth.guard.ts`                                                              |
| Role hierarchy `viewer < editor < admin < owner`               | `apps/api/src/common/roles.ts`                                                                   |
| Tenant context in AsyncLocalStorage                            | `apps/api/src/common/tenant-context.interceptor.ts`                                              |
| `withTenantTx()` / `withPlatformTx()`                          | `apps/api/src/infra/db.service.ts` → `packages/db/src/database.ts`                               |
| Errors as RFC 9457 problem+json, with the trace id             | `apps/api/src/common/problem.ts`                                                                 |

## 3. Three layers of tenant isolation

Each layer would have to fail **on its own** before one tenant could see another's data.

```mermaid
flowchart TB
  REQ["Request"] --> L1
  L1{"1 · Host resolution<br/>exactly one tenant per host"} -->|unknown host| X1["404"]
  L1 --> L2{"2 · Auth guard<br/>token issued for THIS tenant?<br/>member with enough role?"}
  L2 -->|no| X2["401 / 403"]
  L2 --> L3{"3 · Postgres RLS<br/>tenant_id = app.tenant_id<br/>ENABLE + FORCE, role NOBYPASSRLS"}
  L3 -->|other tenant's rows| X3["invisible: 0 rows,<br/>writes rejected by WITH CHECK"]
  L3 --> OK["Only this tenant's rows"]
```

**Database roles** (`packages/db/sql/00-roles.sql`):

| Role                   | Used by                                     | RLS                                                |
| ---------------------- | ------------------------------------------- | -------------------------------------------------- |
| `resourcehub_migrator` | Migrations only (CI / a Container Apps Job) | Owns the tables                                    |
| `resourcehub_app`      | API and worker                              | `NOBYPASSRLS`, owns nothing, so RLS always applies |
| `resourcehub_platform` | Platform console and cross-tenant jobs only | `BYPASSRLS`; every use writes an audit row         |

**Belt and braces:**

- Composite foreign keys `(tenant_id, id)`, so a row can't point at another tenant's row even by bug.
- Blob paths must start with `tenants/{id}/`. A DB CHECK enforces it and the SAS signer refuses other prefixes.
- Cache keys are tenant-namespaced (`apps/api/src/infra/tenant-cache.ts`).
- With no `app.tenant_id` set, the app role sees **zero rows**. It fails closed.

**Proof:**

- `apps/api/test/isolation/` calls every route with tenant B's real ids using tenant A's token.
  A coverage check fails CI when someone adds a route without adding it to the test.
- `pnpm db:check-rls` and the CI `rls-coverage` job fail if any table lacks RLS + FORCE + a policy.
- The k6 load test checks every response for the other tenant's data (see [`performance.md`](performance.md)).

## 4. Data model

```mermaid
erDiagram
  tenants ||--o{ tenant_domains : "custom hosts"
  tenants ||--|| tenant_branding : "theme"
  tenants ||--o{ memberships : ""
  users ||--o{ memberships : "one person, many tenants"
  tenants ||--o{ invitations : ""
  tenants ||--o{ categories : ""
  tenants ||--o{ tags : ""
  categories ||--o{ resources : ""
  resources ||--o{ resource_tags : ""
  tags ||--o{ resource_tags : ""
  tenants ||--o{ files : "tenants/{id}/…"
  tenants ||--o{ integrations : ""
  integrations ||--o{ integration_runs : "sync history"
  tenants ||--o{ audit_log : "append-only"
```

`tenants` and `users` are global. Every other table has `tenant_id`, an index that leads with it,
and an RLS policy, all created in the same migration (`packages/db/drizzle/`). `audit_log` is
INSERT/SELECT only for the app role.

## 5. Integrations

SOAP and partner REST APIs stay at the edge. Domain code only ever sees typed records.

```mermaid
flowchart LR
  ADM["Admin clicks Sync now<br/>or the schedule fires"] -->|"POST /integrations/:id/runs<br/>Idempotency-Key"| API
  API -->|"integration_runs row = queued"| PG[(Postgres)]
  API -->|"job {tenantId, integrationId, runId}"| Q[(BullMQ)]
  Q --> W["Worker<br/>span integration.sync"]
  W --> EG{"SSRF guard<br/>no private / IMDS IPs in prod"}
  EG --> CB{"Circuit breaker<br/>per integration (Redis)"}
  CB --> AD["Adapter<br/>testConnection · fetchChanges · push"]
  AD -->|"WSDL client + WS-Security"| SOAP["SOAP partner"]
  AD -->|"fetch + jittered retry on 429/5xx"| REST["REST partner"]
  AD -->|"Zod-validated records"| W
  W -->|"upsert as drafts, run = succeeded/failed"| PG
```

| Piece                                                | Where                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| Adapter interface, provider catalogue                | `packages/integrations/src/types.ts`, `catalog.ts`, `providers/` |
| SOAP client (committed WSDLs, no runtime WSDL fetch) | `packages/integrations/src/soap/client.ts`                       |
| REST client                                          | `packages/integrations/src/rest/http.ts`                         |
| Retry, circuit breaker, SSRF egress guard            | `packages/integrations/src/resilience/`                          |
| Job processing and run bookkeeping                   | `apps/worker/src/sync.ts`, `apps/worker/src/main.ts`             |

Secrets never live in `integrations.config`. `secret_ref` points at Key Vault (`kv:…`) in Azure,
or at an env var (`env:…`) locally.

## 6. Authentication

```mermaid
sequenceDiagram
  participant B as SPA
  participant A as API
  participant I as IdP (Entra / dev IdP)
  B->>A: GET /auth/login (on contoso host)
  A-->>B: redirect to IdP with PKCE challenge + state
  B->>I: user signs in
  I-->>B: redirect back with code
  B->>A: GET /auth/callback?code
  A->>I: exchange code + verifier
  A-->>B: refresh cookie (HttpOnly, SameSite=Lax, rotating)
  B->>A: POST /auth/refresh
  A-->>B: 15-min access JWT {sub, tid: contoso, ctx: tenant}, kept in memory only
```

- A refresh token that is **reused** revokes the whole session family, writes an audit row, and fires an alert.
- Locally, `AUTH_PROVIDER=dev` swaps in a built-in OIDC provider with a "sign in as" page.
  Config refuses it in production.
- Platform admins sign in on the admin host and get a `ctx: platform` token. That token is useless on tenant hosts.
- Impersonation needs a written reason, shows a banner, and audits every action as "X acting as Y".

## 7. Azure deployment

```mermaid
flowchart TB
  GH["GitHub Actions<br/>OIDC federated login, no secrets"] -->|"build, Trivy scan, push"| ACR["Container Registry"]
  GH -->|"terraform plan/apply"| RG
  subgraph RG["Resource group per env (dev, prod)"]
    FD["Front Door + WAF"] --> CAE
    FD --> WEB["Blob static website (SPA)"]
    subgraph VNET["VNet"]
      subgraph CAE["Container Apps environment"]
        CA1["api"]
        CA2["worker"]
        J["jobs: bootstrap · migrate · seed"]
      end
      PG[("Postgres Flexible<br/>delegated subnet")]
      RD[("Redis<br/>private endpoint")]
    end
    KV["Key Vault"]
    ST[("Storage<br/>no shared keys")]
    LAW["Log Analytics + App Insights<br/>alerts → action group"]
  end
  ACR --> CAE
```

- **On a PR:** lint, typecheck, unit, Testcontainers integration and isolation tests, RLS
  coverage, Playwright, CodeQL, and `pnpm audit`.
- **On merge to `main`:** images are built, scanned and pushed, then Terraform applies, migrations
  run as a job inside the VNet, and the apps deploy to `dev`.
- **On a release tag:** a manual approval gate, then the same images deploy to `prod`.
- Activation steps are in [`runbooks/azure-deploy.md`](runbooks/azure-deploy.md).

## 8. Observability

- `node --import ./dist/instrumentation.js` loads the Azure Monitor OpenTelemetry distro before
  the app. This happens only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set.
- Auto-instrumented: incoming HTTP, outgoing HTTP/SOAP, Postgres and Redis. Each request span is
  tagged with `tenant.id` and `tenant.slug`.
- Each worker job is one span, `integration.<type>`, tagged with tenant, integration, run, attempt
  and outcome. The partner HTTP calls and SQL calls inside it are its children.
- pino JSON logs carry `trace_id`/`span_id`, and credentials are redacted. Error responses return
  the trace id, so a user's error report leads straight to the trace.
- Alerts (`infra/terraform/modules/resourcehub/monitoring.tf`): API 5xx rate, API p95 latency,
  integration failures per tenant, refresh-token reuse, Postgres CPU, and Redis memory.

See [ADR 0007](adr/0007-observability-and-hardening.md).
