import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  lt,
  or,
  schema,
  sql,
  type ResourceStatus,
  type SQL,
  type Tx,
} from '@resourcehub/db';
import type {
  CreateResource,
  Resource,
  ResourcePage,
  ResourceQuery,
  ResourceSummary,
  UpdateResource,
} from '@resourcehub/contracts';
import { DbService } from '../../infra/db.service.js';
import { problems } from '../../common/problem.js';
import { roleAtLeast } from '../../common/roles.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

const r = schema.resources;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'resource'
  );
}

interface Cursor {
  u: string;
  i: string;
}
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.u !== 'string' || !UUID_RE.test(c.i) || Number.isNaN(Date.parse(c.u)))
      throw new Error();
    return c;
  } catch {
    throw problems.badRequest('Invalid cursor.');
  }
}

/** Viewers only ever see published content; editors and up see drafts and archive too. */
export const canSeeUnpublished = (role: string | undefined) => roleAtLeast(role, 'editor');

@Injectable()
export class ResourcesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ResourceQuery, role: string | undefined): Promise<ResourcePage> {
    const cursor = decodeCursor(query.cursor);
    const conds: SQL[] = [];
    const status = query['filter[status]'];
    if (!canSeeUnpublished(role)) conds.push(eq(r.status, 'published'));
    else if (status) conds.push(eq(r.status, status));
    else conds.push(sql`${r.status} <> 'archived'`);
    if (query['filter[featured]'] !== undefined)
      conds.push(eq(r.featured, query['filter[featured]']));
    if (query.q) {
      conds.push(
        or(
          sql`search @@ websearch_to_tsquery('english', ${query.q})`,
          sql`${r.title} ILIKE ${'%' + query.q.replace(/[%_\\]/g, '\\$&') + '%'}`,
        )!,
      );
    }
    if (cursor) {
      conds.push(
        or(
          lt(r.updatedAt, new Date(cursor.u)),
          and(eq(r.updatedAt, new Date(cursor.u)), lt(r.id, cursor.i)),
        )!,
      );
    }

    return this.db.withTenantTx(async (tx) => {
      if (query['filter[category]']) {
        conds.push(
          inArray(
            r.categoryId,
            tx
              .select({ id: schema.categories.id })
              .from(schema.categories)
              .where(eq(schema.categories.slug, query['filter[category]'])),
          ),
        );
      }
      if (query['filter[tag]']) {
        conds.push(
          inArray(
            r.id,
            tx
              .select({ id: schema.resourceTags.resourceId })
              .from(schema.resourceTags)
              .innerJoin(schema.tags, eq(schema.tags.id, schema.resourceTags.tagId))
              .where(eq(schema.tags.slug, query['filter[tag]'])),
          ),
        );
      }
      const rows = await this.selectSummaries(tx)
        .where(and(...conds))
        .orderBy(desc(r.updatedAt), desc(r.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const data = await this.withTags(tx, page);
      const last = page.at(-1);
      return {
        data,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ u: last.updatedAt.toISOString(), i: last.id })
            : null,
      };
    });
  }

  async get(idOrSlug: string, role: string | undefined): Promise<Resource> {
    return this.db.withTenantTx(async (tx) => {
      const where = UUID_RE.test(idOrSlug) ? eq(r.id, idOrSlug) : eq(r.slug, idOrSlug);
      const [row] = await this.selectSummaries(tx, true).where(where);
      // Per-record check: a viewer asking for a draft gets the same 404 as for a missing row.
      if (!row || (row.status !== 'published' && !canSeeUnpublished(role)))
        throw problems.notFound();
      const [summary] = await this.withTags(tx, [row]);
      const attachments = await tx
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.resourceId, row.id), eq(schema.files.status, 'ready')))
        .orderBy(schema.files.createdAt);
      return {
        ...summary!,
        body: row.body ?? { format: 'markdown', content: '' },
        attachments: attachments.map((f) => ({
          id: f.id,
          filename: f.filename,
          mime: f.mime,
          size: f.size,
          status: f.status,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    });
  }

  async create(
    tenantId: string,
    authorId: string,
    actor: AuditActor,
    input: CreateResource,
  ): Promise<Resource> {
    const id = await this.db.withTenantTx(async (tx) => {
      const slug = await this.uniqueSlug(tx, input.slug ?? slugify(input.title));
      const status = input.status ?? 'draft';
      const [row] = await tx
        .insert(r)
        .values({
          tenantId,
          title: input.title,
          slug,
          summary: input.summary ?? null,
          body: { format: 'markdown', content: input.body ?? '' },
          status,
          featured: input.featured ?? false,
          publishedAt: status === 'published' ? new Date() : null,
          categoryId: input.categoryId ?? null,
          authorId,
        })
        .returning({ id: r.id })
        .catch((err: unknown) => {
          throw mapFkError(err);
        });
      await this.setTags(tx, tenantId, row!.id, input.tagIds ?? []);
      await this.audit.record(tx, tenantId, actor, {
        action: 'resource.created',
        entity: 'resource',
        entityId: row!.id,
        diff: { title: input.title, status },
      });
      return row!.id;
    });
    return this.get(id, 'owner');
  }

  async update(
    tenantId: string,
    id: string,
    actor: AuditActor,
    input: UpdateResource,
  ): Promise<Resource> {
    await this.db.withTenantTx(async (tx) => {
      const [current] = await tx.select().from(r).where(eq(r.id, id)).for('update');
      if (!current) throw problems.notFound();
      const patch: Partial<typeof r.$inferInsert> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.slug !== undefined && input.slug !== current.slug)
        patch.slug = await this.uniqueSlug(tx, input.slug);
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.body !== undefined) patch.body = { format: 'markdown', content: input.body };
      if (input.featured !== undefined) patch.featured = input.featured;
      if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
      if (input.status !== undefined && input.status !== current.status) {
        patch.status = input.status;
        if (input.status === 'published' && !current.publishedAt) patch.publishedAt = new Date();
      }
      if (Object.keys(patch).length > 0) {
        try {
          await tx.update(r).set(patch).where(eq(r.id, id));
        } catch (err) {
          throw mapFkError(err);
        }
      }
      if (input.tagIds) await this.setTags(tx, tenantId, id, input.tagIds);

      const changed = Object.keys(patch).filter((k) => k !== 'body');
      await this.audit.record(tx, tenantId, actor, {
        action:
          patch.status === 'published'
            ? 'resource.published'
            : patch.status === 'archived'
              ? 'resource.archived'
              : 'resource.updated',
        entity: 'resource',
        entityId: id,
        diff: {
          fields: [
            ...changed,
            ...(input.body !== undefined ? ['body'] : []),
            ...(input.tagIds ? ['tags'] : []),
          ],
          ...(patch.status ? { status: { from: current.status, to: patch.status } } : {}),
        },
      });
    });
    return this.get(id, 'owner');
  }

  async remove(tenantId: string, id: string, actor: AuditActor): Promise<{ blobPaths: string[] }> {
    return this.db.withTenantTx(async (tx) => {
      const files = await tx
        .select({ path: schema.files.blobPath })
        .from(schema.files)
        .where(eq(schema.files.resourceId, id));
      await tx.delete(schema.files).where(eq(schema.files.resourceId, id));
      const [row] = await tx.delete(r).where(eq(r.id, id)).returning({ title: r.title });
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actor, {
        action: 'resource.deleted',
        entity: 'resource',
        entityId: id,
        diff: { title: row.title },
      });
      return { blobPaths: files.map((f) => f.path) };
    });
  }

  /** Used by integrations: upsert by (external_source, external_id). */
  async upsertExternal(
    tx: Tx,
    tenantId: string,
    rec: {
      source: string;
      externalId: string;
      title: string;
      summary: string;
      body: string;
      url: string | null;
      categoryName: string | null;
      updatedAt: Date;
    },
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const [existing] = await tx
      .select()
      .from(r)
      .where(and(eq(r.externalSource, rec.source), eq(r.externalId, rec.externalId)));
    let categoryId: string | null = null;
    if (rec.categoryName) {
      const slug = slugify(rec.categoryName);
      const [cat] = await tx
        .insert(schema.categories)
        .values({ tenantId, name: rec.categoryName, slug, sort: 100 })
        .onConflictDoUpdate({
          target: [schema.categories.tenantId, schema.categories.slug],
          set: { slug },
        })
        .returning({ id: schema.categories.id });
      categoryId = cat?.id ?? null;
    }
    if (existing) {
      if (
        existing.title === rec.title &&
        existing.summary === rec.summary &&
        existing.body.content === rec.body
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
      slug: await this.uniqueSlug(tx, slugify(rec.title)),
      summary: rec.summary,
      body: { format: 'markdown', content: rec.body },
      status: 'draft',
      categoryId,
      externalSource: rec.source,
      externalId: rec.externalId,
      externalUrl: rec.url,
    });
    return 'created';
  }

  // ---- helpers ------------------------------------------------------------------------------

  private selectSummaries(tx: Tx, withBody = false) {
    return tx
      .select({
        id: r.id,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        status: r.status,
        featured: r.featured,
        publishedAt: r.publishedAt,
        updatedAt: r.updatedAt,
        externalSource: r.externalSource,
        externalId: r.externalId,
        externalUrl: r.externalUrl,
        body: withBody ? r.body : sql<null>`null`,
        categoryId: schema.categories.id,
        categoryName: schema.categories.name,
        categorySlug: schema.categories.slug,
        authorId: schema.users.id,
        authorName: schema.users.name,
      })
      .from(r)
      .leftJoin(schema.categories, eq(schema.categories.id, r.categoryId))
      .leftJoin(schema.users, eq(schema.users.id, r.authorId))
      .$dynamic();
  }

  private async withTags(
    tx: Tx,
    rows: {
      id: string;
      title: string;
      slug: string;
      summary: string | null;
      status: ResourceStatus;
      featured: boolean;
      publishedAt: Date | null;
      updatedAt: Date;
      externalSource: string | null;
      externalId: string | null;
      externalUrl: string | null;
      categoryId: string | null;
      categoryName: string | null;
      categorySlug: string | null;
      authorId: string | null;
      authorName: string | null;
    }[],
  ): Promise<ResourceSummary[]> {
    const ids = rows.map((x) => x.id);
    const tagRows = ids.length
      ? await tx
          .select({
            resourceId: schema.resourceTags.resourceId,
            id: schema.tags.id,
            name: schema.tags.name,
            slug: schema.tags.slug,
          })
          .from(schema.resourceTags)
          .innerJoin(schema.tags, eq(schema.tags.id, schema.resourceTags.tagId))
          .where(inArray(schema.resourceTags.resourceId, ids))
          .orderBy(schema.tags.name)
      : [];
    return rows.map((x) => ({
      id: x.id,
      title: x.title,
      slug: x.slug,
      summary: x.summary,
      status: x.status,
      featured: x.featured,
      publishedAt: x.publishedAt?.toISOString() ?? null,
      updatedAt: x.updatedAt.toISOString(),
      category: x.categoryId
        ? { id: x.categoryId, name: x.categoryName!, slug: x.categorySlug! }
        : null,
      tags: tagRows
        .filter((t) => t.resourceId === x.id)
        .map(({ id, name, slug }) => ({ id, name, slug })),
      author: x.authorId ? { id: x.authorId, name: x.authorName! } : null,
      source:
        x.externalSource && x.externalId
          ? { system: x.externalSource, externalId: x.externalId, url: x.externalUrl }
          : null,
    }));
  }

  private async uniqueSlug(tx: Tx, base: string): Promise<string> {
    const taken = new Set(
      (
        await tx
          .select({ slug: r.slug })
          .from(r)
          .where(or(eq(r.slug, base), sql`${r.slug} LIKE ${base + '-%'}`))
      ).map((x) => x.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  private async setTags(
    tx: Tx,
    tenantId: string,
    resourceId: string,
    tagIds: string[],
  ): Promise<void> {
    await tx.delete(schema.resourceTags).where(eq(schema.resourceTags.resourceId, resourceId));
    if (tagIds.length === 0) return;
    try {
      await tx
        .insert(schema.resourceTags)
        .values([...new Set(tagIds)].map((tagId) => ({ tenantId, resourceId, tagId })));
    } catch (err) {
      throw mapFkError(err);
    }
  }
}

/** A composite-FK violation means "that category/tag doesn't exist in this workspace". */
function mapFkError(err: unknown): unknown {
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code === '23503'
    ? problems.badRequest('Unknown category or tag for this workspace.')
    : err;
}
