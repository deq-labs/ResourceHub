# Security baseline review (OWASP ASVS 4.0.3, Level 2 subset)

The security pass from Phase 7, against the baseline in the spec. Each line names where the
control lives and how it's verified. "Gap" items are known and deliberately deferred.

## Tenant isolation (the part that matters most)

| Control                                                                                        | Where                                      | Verified by                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Host → exactly one tenant before auth; unknown host = 404                                      | `TenantResolverService`, `HostScopeGuard`  | `test/isolation/tenant-resolution.test.ts`                      |
| Token bound to the issuing tenant (`tid`) and host kind (`ctx`)                                | `AuthGuard`                                | `test/isolation/auth-isolation.test.ts`                         |
| RLS ENABLE + FORCE + policy on every table; app role NOBYPASSRLS, owns nothing                 | migrations, `00-roles.sql`                 | `packages/db/test/isolation/rls.test.ts`, CI `rls-coverage` job |
| Cross-tenant FKs impossible (composite `(tenant_id, id)`)                                      | `0002_hub.sql`, `0003_integrations.sql`    | rls.test.ts "composite foreign keys"                            |
| Every route tested against tenant B's real ids, plus a coverage check that fails on new routes | `test/isolation/endpoints.test.ts`         | CI `isolation` job                                              |
| Tenant-namespaced cache keys                                                                   | `TenantScopedCache`                        | `tenant-cache.test.ts`                                          |
| Background jobs carry `tenantId` and run under RLS                                             | worker `runWithTenant`                     | `apps/worker/test/sync.test.ts` (wrong-tenant job is a no-op)   |
| Blob paths prefixed `tenants/{id}/`; signer refuses other prefixes; DB CHECK                   | `StorageService`, `files_blob_path_prefix` | rls.test.ts, hub.test.ts                                        |
| Under load: 25k responses checked for the other tenant's data                                  | `loadtest/k6/two-tenants.js`               | docs/performance.md                                             |

## ASVS mapping

| ASVS            | Requirement (abridged)                               | Status       | Implementation                                                                                                   |
| --------------- | ---------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| V2.1/2.2        | Authentication via a trusted IdP; no local passwords | ✅           | OIDC code + PKCE (S256), Entra External ID; dev IdP refused in production                                        |
| V3.2.1          | New session token on authentication                  | ✅           | Refresh family created at callback                                                                               |
| V3.3.1          | Logout invalidates the session                       | ✅           | Family revoked; cookie cleared                                                                                   |
| V3.3.2 / V3.5.x | Token rotation, theft detection                      | ✅           | Rotating refresh tokens; reuse ⇒ family revoked + audit + alert                                                  |
| V3.4.1–3.4.3    | Cookie `Secure`, `HttpOnly`, `SameSite`              | ✅           | `rh_refresh`: HttpOnly, SameSite=Lax, Secure in Azure, path-scoped                                               |
| V3.5.2          | Tokens not in localStorage                           | ✅           | Access token in memory only (`apps/web/src/lib/api.ts`)                                                          |
| V4.1.1/4.1.3    | Least privilege, deny by default                     | ✅           | Global `AuthGuard` (opt-out via `@Public`), hierarchical `@Roles`, per-record checks                             |
| V4.2.1          | IDOR protection                                      | ✅           | RLS + 404 (not 403) for other tenants' and viewers' hidden records                                               |
| V4.3.1          | Admin interfaces protected                           | ✅           | Platform console only on the admin host with a platform token                                                    |
| V5.1.3          | Input validation (allow-lists)                       | ✅           | Zod on every body/query/param (`nestjs-zod`), upload MIME allow-list, font allow-list                            |
| V5.2.x          | Sanitize untrusted HTML                              | ✅           | Markdown → DOMPurify on render; tests for script/event handlers/`javascript:`                                    |
| V5.3.4          | Parameterised queries                                | ✅           | Drizzle everywhere; `sql\`\`` template parameters only                                                           |
| V5.2.6          | SSRF protection                                      | ✅ (Phase 7) | `assertEgressAllowed`: blocks private, loopback, link-local and IMDS destinations for integrations in production |
| V7.1.1          | No credentials in logs                               | ✅           | pino redaction (authorization, cookies, set-cookie, ticket/token/code query)                                     |
| V7.2.x / V8.3.x | Security events audited; append-only log             | ✅           | `audit_log` INSERT/SELECT only + trigger; diffs redacted                                                         |
| V8.1.x          | Sensitive data at rest                               | ✅           | Azure Postgres/Storage encryption; no account keys (`shared_access_key_enabled=false`)                           |
| V9.1.x          | TLS everywhere                                       | ✅           | Front Door HTTPS redirect, HSTS, Postgres `require_secure_transport`, Redis TLS-only                             |
| V10.3.x         | Dependency integrity                                 | ✅           | Lockfile, `pnpm audit` gate, Dependabot, CodeQL, Trivy, pinned image digests, build-script allow-list            |
| V11.1.4         | Anti-automation                                      | ✅           | Per-IP (Redis) + per-tenant limits, auth tier, invite lockout, WAF rate rule                                     |
| V12.4.x         | Files stored outside webroot, served safely          | ✅           | Private container, short SAS, `Content-Disposition: attachment`                                                  |
| V13.1.x         | API: CSRF, origin                                    | ✅           | Cookie endpoints check `Origin`; SameSite=Lax; API CSP `default-src 'none'`                                      |
| V13.2.x         | Idempotent POST / replay safety                      | ✅           | `Idempotency-Key` (replay, 409 in-flight, 422 mismatch)                                                          |
| V14.4.x         | Security headers                                     | ✅           | helmet (API), Front Door rule (SPA CSP, HSTS, nosniff, referrer policy)                                          |
| V14.5.x         | Origin restriction                                   | ✅           | API rejects requests without our `X-Azure-FDID`                                                                  |

## Findings fixed during the pass

1. **SSRF through integrations.** A tenant admin could point an integration at
   `169.254.169.254` or VNet addresses. Fixed with an egress guard in both REST and SOAP clients,
   and tested.
2. **Vulnerable dependencies.** `drizzle-orm` (<0.45.2, identifier escaping) and `nodemailer`
   (address-parser DoS, `raw` file read) were upgraded. `pnpm audit --prod --audit-level high`
   is now a CI gate. (Both landed in the Phase 6 PR.)
3. **Secrets in logs.** Fastify request logging was off. It's now on, with redaction and trace ids.

## Known gaps (deliberate, documented)

- **DNS rebinding** can race the SSRF check. Production should also send worker egress through a
  NAT/firewall allow-list.
- **Access-token staleness:** a demoted user keeps their old role for up to 15 minutes; removal
  revokes refresh. A role-version claim checked against Redis would close this.
- **Malware scanning** of uploads (Defender for Storage) is not enabled.
- **Per-tenant custom domains** on Front Door are added by an operator (runbook), not automatically.
- **Compliance:** the system is HIPAA/SOC 2-friendly (audit trail, access reviews, retention) but
  certifies nothing. Which regime applies is a question for the client.
