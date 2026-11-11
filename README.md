# ResourceHub

A secure, multi-tenant resource portal. Each organisation (tenant) gets its own branded hub of
SOPs, training and approved materials on its own subdomain, with admin tools, an audit trail and
integrations to outside REST and SOAP systems.

TypeScript end to end: **NestJS 11 on Fastify**, **React 19 + Vite**, **PostgreSQL 16 with
Row-Level Security**, **BullMQ on Redis**, and **Azure** (Container Apps, Front Door, Key Vault)
provisioned with **Terraform** and deployed from **GitHub Actions** using OIDC.

> **Tenant isolation is enforced by the database, not just the app.** Every request runs in a
> transaction pinned to one tenant, the API's Postgres role cannot bypass RLS, and CI fails if any
> tenant table lacks a policy. A two-tenant load test checked 25,000 responses for the other
> tenant's data and found none.

| Read next                                      |                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)           | Diagrams: system, request lifecycle, isolation layers, integrations, Azure |
| [Demo guide](docs/demo.md)                     | 3-minute demo script and a section-by-section tour of the app              |
| [Security review](docs/security.md)            | OWASP ASVS L2 mapping, findings fixed, known gaps                          |
| [Performance](docs/performance.md)             | k6 results and `EXPLAIN` plans under RLS at 50k rows                       |
| [ADRs](docs/adr)                               | Why each major decision was made                                           |
| [Azure runbook](docs/runbooks/azure-deploy.md) | Activating the cloud deployment                                            |
| [Build spec](docs/spec.md)                     | The original phased plan                                                   |

---

## Run it locally

### Prerequisites

- **Node 22** (`.nvmrc`) and **pnpm 12** (`corepack enable` picks up the pinned version)
- **Docker Desktop**, running
- A browser that resolves `*.localhost` to your machine. Chrome, Edge and Firefox do this out
  of the box, so no hosts-file edits are needed.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env        # local-only values; nothing in it is a real secret
```

### 2. Start the backing services

```bash
pnpm infra:up
```

| Service              | Port                                      | What it's for                                             |
| -------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Postgres 16          | `55432`                                   | The database (three roles: migrator, app, platform)       |
| Redis                | `6379`                                    | BullMQ queues, tenant-host cache, rate limits             |
| Azurite              | `10000`                                   | Local Azure Blob Storage for file uploads                 |
| Mailpit              | `1025` SMTP, **http://localhost:8025** UI | Catches invitation emails                                 |
| SOAP mock            | `8088`                                    | A partner document service, described by a committed WSDL |
| REST mock (WireMock) | `8089`                                    | A partner content feed                                    |

### 3. Create the schema and demo data

```bash
pnpm build          # builds the db CLI and every package once
pnpm db:migrate     # tables, roles, RLS policies
pnpm db:seed        # two tenants, eight users, content, four integrations
```

To start again from an empty database, run `pnpm db:reset`.

### 4. Run the apps

```bash
pnpm dev            # API :3000, worker, and web :5173, all in watch mode
```

Then open:

| URL                                 | What you get                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| **http://contoso.localhost:5173**   | Tenant 1: _Contoso Pharma_ (teal branding)                    |
| **http://northwind.localhost:5173** | Tenant 2: _Northwind Health_ (different branding and content) |
| **http://admin.localhost:5173**     | Platform console, which only the platform admin can use       |
| http://localhost:8025               | Mailpit inbox (invitation emails land here)                   |

The REST API's contract is [`packages/contracts/openapi.json`](packages/contracts/openapi.json)
(OpenAPI 3.1, generated from the Zod schemas). Paste it into any OpenAPI viewer to browse it.

The tenant is chosen by the **hostname**, never by the URL path. `nope.localhost:5173` shows "No
workspace here" because an unknown host gets a 404 before any auth runs.

### 5. Sign in

Locally, the API runs a built-in OIDC provider that stands in for Microsoft Entra External ID. It
uses the same code + PKCE flow, but the login page is a "sign in as" picker. The dev provider is
refused when `NODE_ENV=production`.

| User         | Role                                | Good for showing                                               |
| ------------ | ----------------------------------- | -------------------------------------------------------------- |
| Olivia Owens | Owner · Contoso                     | Everything in Contoso, including admin                         |
| Adam Alvarez | Admin · Contoso                     | Members, branding, domains, integrations, audit                |
| Erin Edwards | Editor · Contoso                    | Creating and editing resources, taxonomy                       |
| Victor Vance | Viewer · Contoso                    | Read-only; admin pages and drafts are hidden                   |
| Nora Nguyen  | Owner · Northwind                   | The second tenant                                              |
| Ned Norris   | Editor · Northwind                  |                                                                |
| Sam Sharma   | Viewer · Contoso, Admin · Northwind | One person, two tenants, different roles in each               |
| Pat Platform | Platform admin                      | `admin.localhost` only: create or suspend tenants, impersonate |

You can also type any email address into the picker to sign in as a brand-new user. They'll land on
"No access" until someone invites them.

---

## Everyday commands

```bash
pnpm turbo build lint typecheck test   # the full check (CI runs the same)
pnpm test:integration                  # Testcontainers: real Postgres, including the isolation suite
pnpm db:check-rls                      # fails if any table lacks RLS + FORCE + a policy
pnpm --filter @resourcehub/web e2e     # Playwright smoke tests (needs `pnpm dev` running)
pnpm gen:api                           # regenerate OpenAPI and the SPA's typed client
pnpm infra:down                        # stop the containers (data is kept in a volume)
```

**Load test** (two tenants at once, with every response checked for the other tenant's data):

```bash
docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 grafana/k6:1.3.0 run - < loadtest/k6/two-tenants.js
```

For high request rates, start the API with raised rate limits first. See
[`docs/performance.md`](docs/performance.md).

**Traces locally:** set `APPLICATIONINSIGHTS_CONNECTION_STRING` in `.env` to an App Insights
resource's connection string. The API and worker then export traces, logs and metrics. Without it,
OpenTelemetry stays off and costs nothing.

---

## Deployment

There are two supported targets, built from the same code:

| Target                        | What it is                                                                                                                                                     | Where                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Azure** (production design) | Container Apps, Front Door + WAF, Postgres Flexible Server, Key Vault, Entra External ID, App Insights. Terraform plus GitHub Actions with OIDC                | [`docs/runbooks/azure-deploy.md`](docs/runbooks/azure-deploy.md)              |
| **Free hosted demo**          | Vercel (SPA and edge proxy), Render (API and worker in one container), Neon (Postgres), Render Key Value (Redis). Uses the "sign in as" demo identity provider | [`deploy/free/`](deploy/free), [`apps/web/vercel.json`](apps/web/vercel.json) |

The free demo keeps the same isolation model: Postgres RLS with a non-owner app role, host-based
tenant resolution (each tenant gets its own `*.vercel.app` alias), and an API that only accepts
traffic carrying the edge's shared secret. Setup notes for your own accounts go in a gitignored
`*.local.md` file.

**Rehearse the free deployment locally** before creating any accounts. This runs the real
production image, a Neon-shaped Postgres and a Vercel stand-in that applies `apps/web/vercel.json`:

```bash
pnpm build && pnpm sim:free   # then open http://contoso.localhost:8080 (northwind. and admin. too)
pnpm sim:free:down            # stop and wipe it
```

---

## Repository layout

```
apps/
  api/        NestJS on Fastify: tenant resolution, auth, hub, admin, platform, integrations API
  web/        React 19 SPA: tenant hub + workspace admin + platform console (picked by host)
  worker/     BullMQ consumers: integration syncs (REST/SOAP) and outgoing email
packages/
  db/         Drizzle schema, SQL migrations with RLS policies, seed, db CLI
  contracts/  Zod schemas shared by API and SPA, the generated OpenAPI spec and typed client
  integrations/  Adapter interface, REST + SOAP clients, retry, circuit breaker, SSRF guard
  config/     Shared tsconfig / ESLint presets
deploy/free/      Free-tier image (API + worker in one container) for Render
infra/terraform/  bootstrap (state + GitHub OIDC), module `resourcehub`, envs dev + prod
loadtest/k6/      Two-tenant load test with an isolation check on every response
docs/             Architecture, demo guide, ADRs, security, performance, runbooks
```

---

## Troubleshooting

**`ports are not available ... 55432 ... forbidden by its access permissions` (Windows).**
Hyper-V/WinNAT reserves random port ranges at boot, and sometimes the range includes Postgres's
port. Check with `netsh int ipv4 show excludedportrange protocol=tcp`. To fix it, run an
**elevated** terminal and enter `net stop winnat && net start winnat`, then `pnpm infra:up` again.

**The API exits with a database connection error.** Make sure `pnpm infra:up` finished (it
waits for health checks) and that `.env` exists.

**`contoso.localhost` doesn't resolve.** Some browsers and tools don't map `*.localhost`. Use
Chrome or Edge, or add `127.0.0.1 contoso.localhost northwind.localhost admin.localhost` to your
hosts file.

**Sign-in loops back to the picker.** Cookies are host-scoped. Use the same hostname all the way
through, and don't switch between `localhost` and `127.0.0.1`.

**The worker logs "integration or run vanished; skipping".** A schedule from before your last
`db:reset` is still in Redis. It's harmless and stops after the next schedule reconcile.

**Northwind's integrations fail when you're offline.** They call public internet APIs (a
country-info SOAP service and a news REST API). Contoso's integrations use the local mocks.
