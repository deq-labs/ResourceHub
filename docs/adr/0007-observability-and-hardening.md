# ADR 0007: Observability and production hardening

- Status: accepted
- Date: 2026-11-10

## Context

Phase 7 makes the system operable and defensible. When something breaks, an on-call engineer
must be able to go from a user's error message to the failing span for **that tenant**. The
security baseline needs a pass, and the risks section of the spec says RLS performance and Node
in production should be measured, not assumed.

## Decision

| Concern           | Choice                                                                                                                                                      | Why                                                                                                                                                       | Rejected                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry SDK     | `@azure/monitor-opentelemetry` (the Azure Monitor OTel distro) + `@opentelemetry/api`                                                                       | One package wires traces, metrics, logs and live metrics to App Insights. It's vendor-supported, and the code only depends on the vendor-neutral OTel API | The classic `applicationinsights` SDK (legacy); hand-assembling the OTel SDK and exporters (more moving parts for the same result) |
| Loading           | `node --import ./dist/instrumentation.js`, which registers the `import-in-the-middle` hook, then starts the distro                                          | ESM modules must be patched before they are first imported; an import in `main.ts` would be too late                                                      | `NODE_OPTIONS` in the image (hidden); a `--require` CJS shim (doesn't see ESM)                                                     |
| Off switch        | Enabled only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set                                                                                            | Local dev and tests carry no exporter and no overhead                                                                                                     | Always on with a no-op exporter                                                                                                    |
| Tenant context    | `tenant.id` / `tenant.slug` on the request span; worker spans carry tenant, integration, run and attempt                                                    | Every App Insights query can be sliced by tenant, which is the first question in a multi-tenant incident                                                  | A tenant id in the span name (cardinality explosion)                                                                               |
| Logs              | Fastify's pino logger enabled, with a `trace_id`/`span_id` mixin and redaction of auth headers, cookies and token/code query strings                        | Logs and traces correlate; credentials never leave the process (ASVS V7.1.1)                                                                              | Separate console logging without trace ids                                                                                         |
| Error correlation | problem+json `traceId` is the OTel trace id when tracing is on, otherwise the request id                                                                    | Support can paste the id from a user's screenshot straight into App Insights search                                                                       |                                                                                                                                    |
| Alerts            | Terraform `monitoring.tf`: 5xx rate, p95 latency, integration failures per tenant, refresh-token reuse, Postgres CPU, Redis memory, all to one action group | They cover the failure modes we can actually act on. Token reuse is a security signal, not just an ops one                                                | Alerting on every exception (noise)                                                                                                |
| Sampling          | `OTEL_SAMPLING_RATIO`, default 1.0                                                                                                                          | Demo traffic is tiny. Lower it in prod when ingestion cost matters                                                                                        |                                                                                                                                    |
| SSRF              | `assertEgressAllowed()` in both the REST and SOAP clients: blocks loopback, private, CGNAT, link-local/IMDS and reserved ranges in production               | A tenant admin controls integration endpoints. Without it they could reach `169.254.169.254` or VNet services                                             | Trusting admins (they are tenant users, not operators)                                                                             |
| Load testing      | k6 with two tenants at once and a cross-tenant-leak metric on every response that fails the run on a single leak                                            | It proves isolation under concurrency, not just latency                                                                                                   | Latency-only load tests                                                                                                            |

## Consequences

- Images start with `--import ./dist/instrumentation.js`. The API and worker `start`/`dev`
  scripts do the same, so local and cloud behave identically.
- Two new runtime dependencies (`@azure/monitor-opentelemetry`, `@opentelemetry/api`) in the
  API and worker. The distro is large but only loads when tracing is on.
- The SSRF check runs at call time, so DNS rebinding can still race it. The documented
  mitigation is a NAT/firewall egress allow-list for the worker (see `docs/security.md`).
- `INTEGRATIONS_ALLOW_PRIVATE_NETWORKS=true` re-opens private ranges in production. It exists
  for partners reached over a private link, and must be set deliberately.
- Results of the security pass and the load test are recorded in `docs/security.md` and
  `docs/performance.md`; PII is listed in `docs/data-inventory.md`.
