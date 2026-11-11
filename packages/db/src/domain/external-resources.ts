import { and, eq, like, or } from 'drizzle-orm';
import type { Tx } from '../database.js';
import * as schema from '../schema/index.js';

export interface ExternalRecord {
  externalId: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  url: string | null;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'resource';

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const r = schema.resources;
  const rows = await tx
    .select({ slug: r.slug })
    .from(r)
    .where(or(eq(r.slug, base), like(r.slug, `${base}-%`)));
  const taken = new Set(rows.map((x) => x.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Idempotent upsert of an integration record into the hub, inside the caller's tenant
 * transaction (so RLS applies). New items land as drafts for an editor to review; existing
 * items are updated in place only when something changed.
 */
export async function upsertExternalResource(
  tx: Tx,
  tenantId: string,
  source: string,
  rec: ExternalRecord,
): Promise<'created' | 'updated' | 'unchanged'> {
  const r = schema.resources;
  let categoryId: string | null = null;
  if (rec.category) {
    const slug = slugify(rec.category);
    const [cat] = await tx
      .insert(schema.categories)
      .values({ tenantId, name: rec.category, slug, sort: 100, icon: 'folder' })
      .onConflictDoUpdate({
        target: [schema.categories.tenantId, schema.categories.slug],
        set: { slug },
      })
      .returning({ id: schema.categories.id });
    categoryId = cat?.id ?? null;
  }

  const [existing] = await tx
    .select()
    .from(r)
    .where(and(eq(r.externalSource, source), eq(r.externalId, rec.externalId)));

  if (existing) {
    if (
      existing.title === rec.title &&
      existing.summary === rec.summary &&
      existing.body.content === rec.body &&
      existing.externalUrl === rec.url &&
      existing.categoryId === categoryId
    ) {
      return 'unchanged';
    }
    await tx
      .update(r)
      .set({
        title: rec.title,
        summary: rec.summary,
        body: { format: 'markdown', content: rec.body },
        externalUrl: rec.url,
        categoryId,
      })
      .where(eq(r.id, existing.id));
    return 'updated';
  }

  await tx.insert(r).values({
    tenantId,
    title: rec.title,
    slug: await uniqueSlug(tx, slugify(rec.title)),
    summary: rec.summary,
    body: { format: 'markdown', content: rec.body },
    status: 'draft',
    categoryId,
    externalSource: source,
    externalId: rec.externalId,
    externalUrl: rec.url,
  });
  return 'created';
}
