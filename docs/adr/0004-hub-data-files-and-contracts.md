# ADR 0004: Composite tenant FKs, direct-to-blob uploads, and a generated API contract

- Status: accepted
- Date: 2026-11-10

## 1. Composite foreign keys between tenant tables

Postgres runs foreign key checks **without** RLS. A plain `resources.category_id → categories.id`
would let tenant A attach tenant B's category, and use FK errors to probe whether B's ids exist.
Every reference between tenant tables is therefore `(tenant_id, x_id) → x(tenant_id, id)`, with
`ON DELETE SET NULL (x_id)` (PG 15+) where the reference is optional. A cross-tenant reference
can't exist in the schema. The isolation suite tests this, and the API maps the `23503` error
to a 400 that doesn't reveal anything.

## 2. Files never pass through the API

`POST /files/uploads` records a pending file and returns a **10-minute, write-only, single-blob**
SAS URL. The browser PUTs straight to Blob Storage, then calls `/files/{id}/complete`, and the
API checks the blob's real size before marking it ready. Downloads are 5-minute read SAS URLs with
`Content-Disposition: attachment`.

- Paths are always `tenants/{tenantId}/files/{fileId}/{name}`. A DB `CHECK` constraint enforces
  the prefix, and `StorageService` refuses to sign anything outside the current tenant's prefix.
- In Azure, SAS URLs are signed with a **user delegation key** from the Container App's managed
  identity, so no storage account key exists anywhere. Locally, Azurite uses its well-known dev key.

## 3. One contract, three uses

Zod schemas in `packages/contracts` drive request validation (`nestjs-zod`), response
serialization (`@ZodResponse`) and the OpenAPI 3.1 document (`pnpm gen:api`). `openapi-typescript`
then generates `paths` types for the SPA's `openapi-fetch` client, so a renamed field breaks the
SPA build. A CI job regenerates the contract and fails on any diff.

## 4. Isolation by construction

`test/isolation/endpoints.test.ts` lists every route against tenant B's real ids. It also walks
the OpenAPI document and **fails when a new route has no isolation case**, so "for every endpoint"
stays true as the API grows.

## Consequences

- Taxonomy and resource writes run in one RLS transaction, with an audit row in the same transaction.
- Full-text search uses a generated `tsvector` column (title A, summary B, body C) with a GIN index,
  plus an `ILIKE` fallback on title for partial words.
