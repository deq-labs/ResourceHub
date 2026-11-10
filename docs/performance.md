# Performance: load test and RLS query plans

Measured 2026-11-10 on a laptop (Windows 11, Docker Desktop): one API process, Postgres 16 and Redis
in docker-compose. **The isolation checks matter more than the absolute numbers**: every one
of 25,196 responses under load was checked for the _other_ tenant's data, and none had it.

## k6: two tenants at once (`loadtest/k6/two-tenants.js`)

Each tenant signs in through the real OIDC flow (dev IdP), then a constant arrival rate of
mixed reads: list, search, detail, categories, tags, branding, `/me`. Every response is checked
for a marker that only exists in the other tenant. The table also held **50,000 synthetic
resources across 200 extra tenants** during the run.

| Run  | Rate (both tenants) | Requests | Failed | Cross-tenant leaks | p95     | p99     |
| ---- | ------------------- | -------- | ------ | ------------------ | ------- | ------- |
| 60 s | 120 req/s           | 7,210    | 0      | **0 / 7,202**      | 5.95 ms | 16.0 ms |
| 30 s | 600 req/s           | 17,994   | 0      | **0 / 17,986**     | 5.85 ms | 10.3 ms |

Thresholds that fail the run: `cross_tenant_leaks rate==0`, `http_req_failed < 1%`, `p95 < 300 ms`.

```bash
# API with raised limits so the rate limiter isn't what's being measured
RATE_LIMIT_PER_IP_PER_MINUTE=1000000 RATE_LIMIT_PER_TENANT_PER_MINUTE=1000000 pnpm --filter @resourcehub/api start
docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 -e RATE=300 grafana/k6:1.3.0 run - < loadtest/k6/two-tenants.js
```

## EXPLAIN: does RLS still use indexes at scale?

Yes. Postgres inlines `app_current_tenant()` (a `STABLE` SQL function) into the **index
condition**, so every hot query is an index scan on a `tenant_id`-leading index and never scans
other tenants' rows. Reproduce with:

```bash
pnpm --filter @resourcehub/db db:perf-seed      # 200 tenants x 250 resources
pnpm --filter @resourcehub/db exec node --env-file=../../.env dist/cli.js explain perf-17
pnpm --filter @resourcehub/db db:perf-clean
```

| Query              | Plan                                                                        | Time    |
| ------------------ | --------------------------------------------------------------------------- | ------- |
| list published     | Index Scan Backward `resources_tenant_status_updated_idx`                   | 0.10 ms |
| filter by category | Nested loop of `categories_tenant_id_key` + `resources_tenant_category_idx` | 0.15 ms |
| full-text search   | `resources_tenant_status_updated_idx` + tsvector filter                     | 0.03 ms |
| count by category  | Index-only + `resources_tenant_category_idx`                                | 0.09 ms |

**What to watch.** Full-text search filters the tenant's rows by `tsvector` instead of using the
GIN index, which is correct and fast while a tenant has thousands of resources. At hundreds of
thousands per tenant, add a composite GIN (`btree_gin` on `tenant_id` + `search`) or partition
by tenant.

**Connection pooling.** `SET LOCAL` (via `set_config(..., true)`) is transaction-scoped, so the
design is safe behind PgBouncer in transaction mode. `DB_POOL_MAX` × replicas must stay under the
server's `max_connections` (B1ms: 50). The defaults (10 × max 5 replicas) leave headroom for the worker and jobs.

## Full plans (50,021 resources)

## list published (home / resources page)

```
Limit (actual time=0.079..0.081 rows=21 loops=1)
  Buffers: shared hit=16
  ->  Incremental Sort (actual time=0.079..0.079 rows=21 loops=1)
        Sort Key: updated_at DESC, id DESC
        Presorted Key: updated_at
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
        Buffers: shared hit=16
        ->  Index Scan Backward using resources_tenant_status_updated_idx on resources r (actual time=0.033..0.040 rows=22 loops=1)
              Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (status = 'published'::text))
              Buffers: shared hit=7
Planning:
  Buffers: shared hit=168
Planning Time: 0.630 ms
Execution Time: 0.098 ms
```

## filter by category

```
Limit (actual time=0.103..0.105 rows=21 loops=1)
  Buffers: shared hit=18
  ->  Sort (actual time=0.102..0.103 rows=21 loops=1)
        Sort Key: r.updated_at DESC
        Sort Method: top-N heapsort  Memory: 26kB
        Buffers: shared hit=18
        ->  Nested Loop (actual time=0.045..0.087 rows=187 loops=1)
              Buffers: shared hit=18
              ->  Index Scan using categories_tenant_id_key on categories (actual time=0.022..0.023 rows=1 loops=1)
                    Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Filter: (slug = 'general'::text)
                    Buffers: shared hit=3
              ->  Index Scan using resources_tenant_category_idx on resources r (actual time=0.021..0.053 rows=187 loops=1)
                    Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (category_id = categories.id))
                    Filter: (status = 'published'::text)
                    Rows Removed by Filter: 63
                    Buffers: shared hit=15
Planning:
  Buffers: shared hit=125
Planning Time: 0.649 ms
Execution Time: 0.152 ms
```

## full-text search

```
Limit (actual time=0.010..0.016 rows=21 loops=1)
  Buffers: shared hit=7
  ->  Index Scan Backward using resources_tenant_status_updated_idx on resources r (actual time=0.010..0.015 rows=21 loops=1)
        Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (status = 'published'::text))
        Filter: (search @@ '''cold'' & ''chain'''::tsquery)
        Buffers: shared hit=7
Planning:
  Buffers: shared hit=27
Planning Time: 0.590 ms
Execution Time: 0.027 ms
```

## count by category (taxonomy)

```
GroupAggregate (actual time=0.054..0.054 rows=1 loops=1)
  Group Key: c.id
  Buffers: shared hit=18
  ->  Nested Loop Left Join (actual time=0.017..0.046 rows=187 loops=1)
        Buffers: shared hit=18
        ->  Index Only Scan using categories_tenant_id_key on categories c (actual time=0.008..0.008 rows=1 loops=1)
              Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
              Heap Fetches: 1
              Buffers: shared hit=3
        ->  Index Scan using resources_tenant_category_idx on resources r (actual time=0.008..0.029 rows=187 loops=1)
              Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (category_id = c.id))
              Filter: (status = 'published'::text)
              Rows Removed by Filter: 63
              Buffers: shared hit=15
Planning:
  Buffers: shared hit=7
Planning Time: 0.143 ms
Execution Time: 0.090 ms
```
