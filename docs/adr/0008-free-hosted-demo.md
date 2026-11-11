# ADR 0008: A free hosted demo alongside Azure

- Status: accepted
- Date: 2026-11-10

## Context

Azure (ADR 0006) is the production design, but leaving even the smallest dev environment running
costs about $60–90 a month. A public demo link should cost nothing and change no application
design.

## Decision

| Concern      | Choice                                                                                                                                                                                | Why                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPA + edge   | Vercel, with an **external rewrite** of `/api/*` to the API                                                                                                                           | Same origin for SPA and API, so the `SameSite=Lax` refresh cookie keeps working. Vercel forwards `x-forwarded-host`, so host-based tenant resolution is unchanged |
| Origin lock  | `EDGE_SECRET`, sent as `X-Edge-Secret` by a Vercel header transform and compared in constant time                                                                                     | The provider-neutral twin of Front Door's `X-Azure-FDID` check. A visitor can't forge it because Vercel overwrites the header                                     |
| Caching      | API responses through the rewrite are explicitly **not cached**                                                                                                                       | A shared CDN cache in front of a multi-tenant API is a cross-tenant leak waiting to happen                                                                        |
| Compute      | Render free web service, with **API and worker in one container** under a small Node supervisor (`deploy/free/start.mjs`)                                                             | Free tiers don't offer background workers. The supervisor forwards SIGTERM so both processes drain, and exits if either dies                                      |
| Postgres     | Neon, with roles created by the existing `bootstrap` command                                                                                                                          | Same three-role model, and the app role is created with plain SQL, so it has no inherited privileges                                                              |
| Tenant hosts | One free `*.vercel.app` alias per tenant, attached by an audited operator command (`db map-domain`)                                                                                   | Aliases can't hold DNS TXT records, so the in-app verification flow can't be used. Mapping is a platform action, so it's audited like one                         |
| Sign-in      | The dev IdP, allowed in production only with `ALLOW_DEV_IDP_IN_PRODUCTION=true`, redirecting only to hosts listed in `DEV_IDP_REDIRECT_HOSTS` (exact https host, exact callback path) | A demo audience needs the persona picker. Entra remains the production path                                                                                       |

**A fix found on the way:** `bootstrap` failed as a non-superuser admin on PostgreSQL 16+
(`must be able to SET ROLE "resourcehub_migrator"`). Since PG16, creating a role no longer lets
its creator hand ownership to it. Azure Flexible Server's admin is also a non-superuser, so the
Azure bootstrap job would have hit the same error. The admin now grants itself membership in the
migrator role first. `packages/db/test/bootstrap.test.ts` covers it on Postgres 17, and the test
fails without the fix.

## Consequences

- The hosted demo lets anyone sign in as any persona. It's disposable by design: reset it with
  `seed` + `map-domain`, and never put real data in it.
- Contoso's partner integrations can't run hosted: they target the local mocks, and production
  refuses `env:` secret refs. Northwind's public integrations work.
- File uploads need an Azure Storage account reached by connection string. The storage code only
  speaks Azure Blob, and an S3/R2 adapter would add dependencies.
- No new dependencies. `apps/web/vercel.json` holds the API URL, which is not a secret. Account-
  specific setup notes live in gitignored `*.local.md` files.
