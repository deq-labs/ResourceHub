# Demo guide

Part 1 is a **3-minute script** for the recorded video. Part 2 is a **tour of every section of
the app**: what it is, how to show it, what to say, and where it lives in the code. Use Part 2 for
a longer live walkthrough or for interview questions.

The architecture diagrams to show alongside are in [`architecture.md`](architecture.md).

---

## Before you record

```bash
pnpm infra:up && pnpm db:reset && pnpm build && pnpm dev
```

- Use Chrome. Open four tabs: `contoso.localhost:5173`, `northwind.localhost:5173`,
  `admin.localhost:5173` and `localhost:8025` (Mailpit).
- Use a **separate Chrome profile or incognito window per tenant** if you want to stay signed
  in to several at once. Cookies are per host, so this mostly works anyway.
- Have a terminal ready in the repo root, with the font at least 16 pt.
- Run the SOAP sync once beforehand if you want run history on screen. Run `pnpm db:reset`
  again if you want a clean "6 new" result during the recording.

---

## Part 1: the 3-minute script

| Time          | Show                                                                                                                                                        | Say                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00–0:20** | README top, then the system diagram in `docs/architecture.md`                                                                                               | "ResourceHub is a multi-tenant resource portal: NestJS and React in TypeScript, Postgres, and Azure. The interesting part is how tenants are kept apart, so that's where I'll spend the time."                                                                                                                                                                         |
| **0:20–0:50** | `contoso.localhost:5173` → _Sign in with single sign-on_ → **Erin Edwards**. Home page, then search for "near miss" and open it                             | "Each tenant lives on its own hostname. The API works out the tenant from the Host header, never from the URL. Sign-in is OIDC with PKCE; locally a built-in provider stands in for Entra External ID. Erin is an editor, so she sees drafts too."                                                                                                                     |
| **0:50–1:05** | `northwind.localhost:5173` → sign in as **Nora Nguyen**                                                                                                     | "Same code, same database, a different tenant: different branding, different content, and no trace of Contoso."                                                                                                                                                                                                                                                        |
| **1:05–1:35** | Terminal: the psql snippet below                                                                                                                            | "This is the guarantee. As the API's own database role, with no tenant set, I get zero rows. I set the tenant and get only Contoso's rows. RLS is FORCEd and the role can't bypass it, so even a bug in a service can't leak another tenant's data. CI fails if any table lacks a policy, and the isolation suite calls every route with the other tenant's real ids." |
| **1:35–2:05** | Contoso as **Olivia Owens** → Admin → Integrations → _Test connection_, then _Sync now_ on "Partner document library". Then Resources → filter drafts       | "Outside systems sit behind one adapter interface. This one is SOAP, built from a committed WSDL with WS-Security. Syncs run as BullMQ jobs in the worker, never in the request, with retries, a circuit breaker and an SSRF guard. Partner documents arrive as drafts for review."                                                                                    |
| **2:05–2:30** | Admin → Audit log (filter by action). Then `admin.localhost:5173` as **Pat Platform** → Tenants → _Impersonate_ Victor with a reason → the new tab's banner | "Every admin action is audited, and the log is append-only at the database level. Platform staff use a separate host and token. Impersonation needs a written reason, shows a banner, and is audited as 'Pat acting as Victor'."                                                                                                                                       |
| **2:30–2:50** | `docs/performance.md` table, then `infra/terraform` and `.github/workflows`                                                                                 | "Under load, two tenants at 600 requests a second, every response was checked for the other tenant's data, and there were zero leaks with p95 around 6 ms. `EXPLAIN` shows RLS still uses tenant-leading indexes at 50,000 rows. Azure is all Terraform, deployed from GitHub Actions with OIDC (no stored secrets) and traced into App Insights with alerts."         |
| **2:50–3:00** | The isolation-layers diagram                                                                                                                                | "Three layers, each of which has to fail on its own: host resolution, the auth guard, and Postgres RLS. That's ResourceHub."                                                                                                                                                                                                                                           |

**psql snippet for 1:05**, as the API's role (`resourcehub_app`):

```bash
docker compose exec -e PGPASSWORD=app_dev_pw postgres psql -U resourcehub_app -d resourcehub
```

```sql
SELECT count(*) FROM resources;                                     -- 0: no tenant set, fails closed
BEGIN;
SELECT set_config('app.tenant_id', '01960000-0000-7000-8000-00000000c001', true);  -- Contoso
SELECT count(*) FROM resources;                                     -- 9: Contoso's rows only (15 once a partner sync has run)
COMMIT;
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'resourcehub%';     -- app = f
```

---

## Part 2: a tour of each section

Each section covers: **What**, **Show**, **Say**, and **Code**.

### 1. Tenant resolution: "which workspace am I in?"

- **What:** The hostname picks the tenant (`contoso.localhost`, `northwind.localhost`, or a
  verified custom domain). Unknown hosts get a 404 before any auth runs. Suspended tenants get a
  "This workspace is suspended" page.
- **Show:** `nobody.localhost:5173` shows "No workspace here".
- **Say:** "The tenant is never in the URL or the request body, so there's nothing for a user to
  tamper with. Lookups are cached in Redis for five minutes."
- **Code:** `apps/api/src/modules/tenants/tenant-resolver.service.ts`, the `onRequest` hook in
  `apps/api/src/app.factory.ts`, `apps/api/test/isolation/tenant-resolution.test.ts`.

### 2. Sign-in and sessions

- **What:** OIDC authorization code + PKCE. The API issues a 15-minute access token, held only in
  memory in the SPA, plus a rotating refresh cookie (`HttpOnly`, `SameSite=Lax`). The token is
  bound to the tenant that issued it.
- **Show:** Sign in on Contoso and point out the IdP page: "In Azure this screen is Microsoft Entra
  External ID." Sign in as **Sam Sharma** on both tenants: viewer in Contoso, admin in Northwind.
- **Say:** "One person can belong to many tenants with a different role in each. A Contoso token
  presented on Northwind's host gets a 403, even for Sam. Reusing a refresh token revokes the
  whole session family and fires an alert, because that's what token theft looks like."
- **Code:** `apps/api/src/modules/auth/`, `apps/api/src/common/auth.guard.ts`,
  `apps/api/src/modules/dev-idp/`, `apps/web/src/lib/auth.tsx`,
  `apps/api/test/isolation/auth-isolation.test.ts`.

### 3. The hub: home, resources, search, detail

- **What:** The tenant's library. The home page has categories and recently updated items. The
  resource list has search (Postgres full-text), category and tag filters, and cursor pagination.
  The detail page renders Markdown sanitised with DOMPurify, and has attachments.
- **Show:** As Erin, search "near miss" and open the result. Download an attachment.
- **Say:** "Search runs in Postgres, scoped by RLS like everything else. Attachments live in Blob
  Storage under `tenants/{id}/`, and the API only hands out short-lived SAS URLs for that prefix."
- **Code:** `apps/web/src/routes/home.tsx`, `resources.tsx`, `resource-detail.tsx`;
  `apps/api/src/modules/resources/`, `apps/api/src/modules/files/`,
  `apps/api/src/infra/storage.service.ts`.

### 4. Editing and taxonomy (editor and above)

- **What:** Create and edit resources with a Write/Preview Markdown editor, uploads (MIME
  allow-list, size limit), draft/publish, and category/tag management under **Taxonomy**.
- **Show:** As Erin, click _New resource_, write some Markdown, preview it, attach a PDF and
  publish. Then sign in as **Victor Vance** (viewer): no Taxonomy link, no edit buttons, and a
  draft's URL says "Resource not found".
- **Say:** "Roles form a hierarchy: viewer, editor, admin, owner. The UI hides what you can't do,
  but the API is what enforces it, and it returns 404 rather than 403 for things you shouldn't
  know exist. Every create takes an `Idempotency-Key`, so a double-click can't make two
  resources."
- **Code:** `apps/web/src/routes/resource-editor.tsx`, `taxonomy.tsx`;
  `apps/api/src/common/roles.ts`, `apps/api/src/common/idempotency.interceptor.ts`.

### 5. Workspace admin (admin and owner)

The **Admin** link opens six tabs:

| Tab              | What to show                                                           | What to say                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Members**      | List, change a role, remove someone                                    | "Removing someone revokes their refresh sessions immediately. Only an owner can change an owner, and the last owner can't be removed."                      |
| **Invitations**  | Invite `new.hire@example.com` as editor, open Mailpit, follow the link | "Tokens are single-use, stored only as SHA-256 hashes, and expire in 7 days. Repeated failed invites trigger a lockout."                                    |
| **Branding**     | Change the primary colour and font and watch the **Live preview**      | "Branding is CSS variables loaded at boot. Fonts come from an allow-list so a tenant can't inject arbitrary CSS."                                           |
| **Domains**      | Add `portal.contoso-mfg.localhost` and verify it, then open it         | "In production, ownership is proved with a DNS TXT record. Locally, `.localhost` names verify instantly. A custom domain only resolves after verification." |
| **Integrations** | See section 6                                                          |                                                                                                                                                             |
| **Audit log**    | Filter by action, e.g. `auth.login` or `membership.role_changed`       | "The audit log is append-only. The app's DB role can only INSERT and SELECT, and a trigger blocks updates. Diffs redact secrets."                           |

- **Code:** `apps/web/src/routes/admin.tsx`; `apps/api/src/modules/{admin,invitations,branding,domains,audit}/`;
  `apps/web/src/lib/branding.tsx`.

### 6. Integrations: REST and SOAP partners

- **What:** Each tenant configures connections to outside systems. Contoso has a **SOAP partner
  document library** and a **REST partner content feed**, both served by local mocks in
  docker-compose. Northwind has a public SOAP country-info service and a public REST news API.
- **Show:** As Olivia: _Test connection_ shows "Connected in N ms", then _Sync now_ moves the run
  from queued to succeeded with "6 fetched · 6 new". Open Resources → drafts to see
  "Lockout/tagout procedure" and the other partner documents.
- **Say:** "SOAP stays at the edge. The WSDL is committed, never fetched at runtime, and XML is
  mapped to Zod-validated types before the rest of the app sees it. Syncs are BullMQ jobs with
  jittered retries and a per-integration circuit breaker. The integration stores a _reference_ to
  a Key Vault secret, never the secret. In production, an SSRF guard stops a tenant admin from
  pointing an integration at Azure's metadata service or our private network."
- **Code:** `apps/web/src/routes/integrations.tsx`; `apps/api/src/modules/integrations/`;
  `apps/worker/src/sync.ts`; `packages/integrations/src/` (`soap/`, `rest/`, `resilience/`,
  `providers/`); `packages/integrations/wsdl/`.

### 7. Platform console (`admin.localhost`)

- **What:** The operator's view across tenants: create tenants, suspend or reactivate them,
  impersonate a member, and read the platform audit trail. Only platform admins can sign in
  here, and their token doesn't work on tenant hosts.
- **Show:** As **Pat Platform**: _New tenant_; _Impersonate_ → choose Victor → enter a reason →
  the new tab shows the banner "Pat Platform is viewing as Victor Vance. Every action is audited."
  Then open Contoso's audit log as Olivia to find the impersonation entry.
- **Say:** "Cross-tenant work uses a separate Postgres role that can bypass RLS, and every use of
  it writes an audit row. Suspending a tenant ends all of its sessions at once."
- **Code:** `apps/web/src/platform/PlatformApp.tsx`; `apps/api/src/modules/platform/`;
  `withPlatformTx()` in `apps/api/src/infra/db.service.ts`.

### 8. Isolation proof (for the technical audience)

- **What:** Tests that gate merging.
- **Show:** `pnpm test:integration` (Testcontainers spins up a real Postgres), then
  `pnpm db:check-rls`, then the `isolation` and `rls-coverage` jobs in `.github/workflows/ci.yml`.
- **Say:** "The endpoint suite discovers every route and calls it as tenant A with tenant B's real
  ids. If someone adds a route and doesn't cover it, the suite fails. The RLS check fails the build
  if any table is missing ENABLE, FORCE or a policy."
- **Code:** `apps/api/test/isolation/`, `packages/db/test/isolation/rls.test.ts`,
  `packages/db/src/rls-check.ts`.

### 9. Performance and load

- **What:** A k6 test with both tenants at once and a leak check on every response, plus
  `EXPLAIN` plans at 50,000 rows.
- **Show:** `docs/performance.md`. Live, run the k6 command from the README for 15 seconds.
- **Say:** "Postgres inlines the tenant setting into the index condition, so RLS doesn't turn into
  table scans. `SET LOCAL` is transaction-scoped, so it's safe behind PgBouncer in transaction
  mode. Pool size times replicas is kept under the server's connection limit."
- **Code:** `loadtest/k6/two-tenants.js`, `packages/db/src/perf.ts`.

### 10. Azure, CI/CD and observability

- **What:** Terraform for every resource. GitHub Actions deploys to dev on merge and to prod on
  tag, signing in to Azure with OIDC. Traces, logs and alerts go to App Insights.
- **Show:** `infra/terraform/modules/resourcehub/` (`apps.tf`, `monitoring.tf`), the deploy
  workflow, and the Azure diagram in `architecture.md`. If dev is deployed, show an App Insights
  transaction search filtered on `tenant.slug`.
- **Say:** "No credentials are stored anywhere: GitHub federates to Entra, apps read Key Vault with
  managed identity, and storage has shared keys disabled. Every request span is tagged with the
  tenant, so in an incident the first question, 'which tenant?', is one filter away. An error
  response carries the trace id, so a user's screenshot leads straight to the trace."
- **Code:** `infra/terraform/`, `.github/workflows/`, `apps/*/src/instrumentation.ts`,
  [`adr/0006`](adr/0006-azure-hosting-and-delivery.md), [`adr/0007`](adr/0007-observability-and-hardening.md),
  [`runbooks/azure-deploy.md`](runbooks/azure-deploy.md).

---

## Likely questions

| Question                                                    | Short answer                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why RLS rather than `WHERE tenant_id = ?` everywhere?       | One forgotten WHERE is a breach. RLS makes the database refuse, and the app role can't opt out.                                                       |
| What if the tenant setting leaks across pooled connections? | It's `set_config(…, true)`, which is transaction-local and gone at COMMIT. With nothing set, the app role sees zero rows.                             |
| Why not schema-per-tenant?                                  | Migrations multiply, and so do connection pools. Shared tables with RLS scale to thousands of tenants cheaply.                                        |
| How do background jobs stay isolated?                       | Each job carries `tenantId` and opens its own tenant transaction. A job for the wrong tenant is a no-op (tested).                                     |
| Why NestJS?                                                 | It's the closest thing to Laravel's structure (modules, DI, guards, pipes), and Fastify underneath is fast.                                           |
| What's not done?                                            | See "Known gaps" in [`security.md`](security.md): DNS-rebinding egress firewall, role-change staleness up to 15 minutes, malware scanning of uploads. |
