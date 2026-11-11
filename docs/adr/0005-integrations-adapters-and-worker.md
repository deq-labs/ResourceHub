# ADR 0005: Integrations behind one adapter interface, run by a BullMQ worker

- Status: accepted
- Date: 2026-11-10

## Context

The client probably has legacy partners (EHR, insurance, ERP) that only speak SOAP, alongside
modern REST APIs. Neither should leak transport details into domain code, and a slow or broken
partner must never slow down a user's request.

## Decision

**One interface.** Every partner implements
`IntegrationAdapter<TConfig, TRecord>` (`testConnection`, `fetchChanges(since)` as an async
iterator, `push`). Adapters live in `packages/integrations`, and so does every trace of XML, WSDL,
HTTP status codes and partner JSON. Each one maps to the Zod-validated `ExternalDocument` at the
edge and returns `Result<_, IntegrationError>`, where errors carry `code` + `retryable`.

**SOAP.** The `soap` package builds clients from **committed WSDLs** (no runtime WSDL fetch).
WS-Security UsernameToken (text or digest) and client-certificate (mTLS) security are supported.
SOAP faults and transport errors map to `auth` / `rejected` (not retryable) or `unavailable` /
`timeout` (retryable). The demo includes a private partner (the docker-compose mock, which enforces
WS-Security) and the public CountryInfoService.

**REST.** Node's undici `fetch`, a per-request `AbortSignal.timeout`, retries with full-jitter
exponential backoff on 429/5xx/network errors (honouring `Retry-After`), and a **circuit breaker
per integration**. Breaker state lives in Redis, so all worker replicas agree a partner is down.
Auth failures and contract violations don't trip the breaker; the partner is up, our request is wrong.

**Execution.** Syncs and pushes **never run inside a request**. The API writes an
`integration_runs` row (`queued`) and enqueues a BullMQ job with `jobId = runId` and the
`tenantId` in the payload. The worker wraps the whole job in `runWithTenant()`, so every write is
RLS-scoped. Even a job carrying the wrong tenant id can only see that tenant's rows. Records are
upserted by `(tenant_id, external_source, external_id)` in small batches and arrive as **drafts** for
editors to review. The high-water mark (`last_synced_at`) moves back 5 minutes to absorb clock skew.
Schedules are BullMQ job schedulers per integration. The worker re-registers them at startup using
the platform role, which is the one cross-tenant action, and it's audited.

**Secrets.** `integrations.secret_ref` is a pointer (`env:NAME` locally, `kv:name` for Key Vault
through managed identity). It's constrained by a DB `CHECK`, never returned with a secret
value, and `env:` refs are refused in production.

**Testing.** Contract tests run each adapter over real HTTP against the SOAP mock built from the
committed WSDL, a recorded public-SOAP response, and the WireMock JSON fixtures (429 → retry,
401 → no retry, schema drift → `invalid_response`). Worker tests run real jobs against
Testcontainers Postgres with RLS.

## Consequences

- A new partner is one adapter file plus one catalog entry. Domain code doesn't change.
- Spans per run are added in Phase 7. `integration_runs.trace_id` already records the request id
  that triggered each run.
