# ADR 0006: Azure hosting, network boundaries and delivery

- Status: accepted
- Date: 2026-11-10

## Decision

| Concern     | Choice                                                                            | Why                                                                                    |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Compute     | Container Apps (api, worker) + Container Apps Jobs (bootstrap, migrate, seed)     | Scale to zero, KEDA built in, jobs run inside the VNet where Postgres lives            |
| Edge        | Front Door (Standard; Premium switch for managed OWASP rules)                     | One wildcard edge for every tenant host, WAF rate limit, security headers, SPA rewrite |
| SPA         | Blob static website behind Front Door                                             | Deployable with OIDC + `--auth-mode login` (no deployment tokens), CSP set at the edge |
| Data        | Postgres Flexible Server 16 in a delegated subnet, no public access, TLS required | Isolation by network _and_ by RLS                                                      |
| Cache/queue | Redis Basic, private endpoint, `noeviction`                                       | BullMQ must never lose keys                                                            |
| Files       | Storage with `shared_access_key_enabled = false`                                  | Only user-delegation SAS from the managed identity; there are no keys to leak          |
| Secrets     | Key Vault (RBAC), Container Apps secret refs via managed identity                 | No connection strings in env files or images                                           |

**Origin lock-down.** Container Apps ingress is public, so the API refuses any request whose
`X-Azure-FDID` doesn't match this Front Door profile's id (health probes excepted). Front Door
forwards the original host as `X-Forwarded-Host`. With `TRUST_PROXY=true` the API resolves the
tenant from it, while Container Apps still receives its own hostname.

**Secrets in state.** Generated secrets (DB passwords, JWT key) live in Terraform state, which
is an Entra-auth-only storage account. Secrets humans own (OIDC client secret, partner
credentials) are created as placeholders with `ignore_changes`, so their real values never touch state.

**Delivery.** GitHub Actions logs in to Azure with OIDC federated credentials scoped to this repo's
`main`, PRs and the `dev`/`prod` environments. Every merge deploys dev. A `v*` tag deploys prod after
the `prod` environment's reviewers approve, and **promotes the identical images** (`az acr import`)
instead of rebuilding them. Migrations run as a job **before** the app revision changes. That
requires expand/contract migrations (add column → deploy → backfill → drop later), which is the
rule for this codebase.

## Consequences

- Dev costs roughly $60–90/month when left up; `terraform destroy` brings it to zero.
- Wildcard TLS needs a customer certificate in Key Vault. Per-tenant custom domains are verified
  in-app, then added to Front Door by an operator (runbook), with automation as follow-up work.
- The pipeline can't be exercised end to end without a subscription. `terraform validate` runs on
  every infra PR, and `deploy.yml` stays dormant until the repository variables exist.
