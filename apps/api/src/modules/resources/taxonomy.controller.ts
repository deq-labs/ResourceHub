import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Category,
  CategoryList,
  CreateCategory,
  CreateTag,
  Tag,
  TagList,
  UpdateCategory,
} from '@resourcehub/contracts';
import { and, count, eq, schema, sql } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { problems } from '../../common/problem.js';
import { authOf, tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { DbService } from '../../infra/db.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';
import { canSeeUnpublished, slugify } from './resources.service.js';

class CategoryListDto extends createZodDto(CategoryList) {}
class CategoryDto extends createZodDto(Category) {}
class CreateCategoryDto extends createZodDto(CreateCategory) {}
class UpdateCategoryDto extends createZodDto(UpdateCategory) {}
class TagListDto extends createZodDto(TagList) {}
class TagDto extends createZodDto(Tag) {}
class CreateTagDto extends createZodDto(CreateTag) {}

const c = schema.categories;
const t = schema.tags;
const res = schema.resources;

function uniqueViolation(err: unknown): boolean {
  return (err as { cause?: { code?: string } }).cause?.code === '23505';
}

@ApiTags('taxonomy')
@Controller()
export class TaxonomyController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private visible(req: FastifyRequest) {
    return canSeeUnpublished(authOf(req).role)
      ? sql`${res.status} <> 'archived'`
      : eq(res.status, 'published');
  }

  @Get('categories')
  @ZodResponse({ status: 200, type: CategoryListDto })
  async categories(@Req() req: FastifyRequest) {
    const rows = await this.db.withTenantTx((tx) =>
      tx
        .select({
          id: c.id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          icon: c.icon,
          sort: c.sort,
          resourceCount: count(res.id),
        })
        .from(c)
        .leftJoin(res, and(eq(res.categoryId, c.id), this.visible(req)))
        .groupBy(c.id)
        .orderBy(c.sort, c.name),
    );
    return { data: rows };
  }

  @Post('categories')
  @Roles('editor')
  @Idempotent()
  @ZodResponse({ status: 201, type: CategoryDto })
  async createCategory(@Req() req: FastifyRequest, @Body() body: CreateCategoryDto) {
    const tenantId = tenantOf(req).id;
    return this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .insert(c)
        .values({
          tenantId,
          name: body.name,
          slug: body.slug ?? slugify(body.name),
          description: body.description ?? null,
          icon: body.icon ?? null,
          sort: body.sort ?? 0,
        })
        .returning()
        .catch((err: unknown) => {
          throw uniqueViolation(err) ? problems.conflict('A category with that slug exists.') : err;
        });
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'category.created',
        entity: 'category',
        entityId: row!.id,
        diff: { name: body.name },
      });
      return { ...row!, resourceCount: 0 };
    });
  }

  @Patch('categories/:id')
  @Roles('editor')
  @ZodResponse({ status: 200, type: CategoryDto })
  async updateCategory(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    const tenantId = tenantOf(req).id;
    return this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .update(c)
        .set(body)
        .where(eq(c.id, id))
        .returning()
        .catch((err: unknown) => {
          throw uniqueViolation(err) ? problems.conflict('A category with that slug exists.') : err;
        });
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'category.updated',
        entity: 'category',
        entityId: id,
        diff: { fields: Object.keys(body) },
      });
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(res)
        .where(eq(res.categoryId, id));
      return { ...row, resourceCount: n };
    });
  }

  @Delete('categories/:id')
  @Roles('admin')
  @HttpCode(204)
  async deleteCategory(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const tenantId = tenantOf(req).id;
    await this.db.withTenantTx(async (tx) => {
      const [row] = await tx.delete(c).where(eq(c.id, id)).returning({ name: c.name });
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'category.deleted',
        entity: 'category',
        entityId: id,
        diff: { name: row.name },
      });
    });
  }

  @Get('tags')
  @ZodResponse({ status: 200, type: TagListDto })
  async tags(@Req() req: FastifyRequest) {
    const rows = await this.db.withTenantTx((tx) =>
      tx
        .select({ id: t.id, name: t.name, slug: t.slug, resourceCount: count(res.id) })
        .from(t)
        .leftJoin(schema.resourceTags, eq(schema.resourceTags.tagId, t.id))
        .leftJoin(res, and(eq(res.id, schema.resourceTags.resourceId), this.visible(req)))
        .groupBy(t.id)
        .orderBy(t.name),
    );
    return { data: rows };
  }

  @Post('tags')
  @Roles('editor')
  @Idempotent()
  @ZodResponse({ status: 201, type: TagDto })
  async createTag(@Req() req: FastifyRequest, @Body() body: CreateTagDto) {
    const tenantId = tenantOf(req).id;
    return this.db.withTenantTx(async (tx) => {
      const slug = slugify(body.name);
      const [row] = await tx
        .insert(t)
        .values({ tenantId, name: body.name.toLowerCase(), slug })
        .onConflictDoUpdate({ target: [t.tenantId, t.slug], set: { slug } })
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'tag.created',
        entity: 'tag',
        entityId: row!.id,
      });
      return { id: row!.id, name: row!.name, slug: row!.slug, resourceCount: 0 };
    });
  }

  @Delete('tags/:id')
  @Roles('admin')
  @HttpCode(204)
  async deleteTag(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const tenantId = tenantOf(req).id;
    await this.db.withTenantTx(async (tx) => {
      const [row] = await tx.delete(t).where(eq(t.id, id)).returning({ name: t.name });
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'tag.deleted',
        entity: 'tag',
        entityId: id,
        diff: { name: row.name },
      });
    });
  }
}
