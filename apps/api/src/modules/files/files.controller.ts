import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateUpload, DownloadLink, FileInfo, UploadTicket } from '@resourcehub/contracts';
import { and, eq, newId, schema } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { problems } from '../../common/problem.js';
import { authOf, tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { DbService } from '../../infra/db.service.js';
import { StorageService } from '../../infra/storage.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';
import { canSeeUnpublished } from '../resources/resources.service.js';

class CreateUploadDto extends createZodDto(CreateUpload) {}
class UploadTicketDto extends createZodDto(UploadTicket) {}
class FileInfoDto extends createZodDto(FileInfo) {}
class DownloadLinkDto extends createZodDto(DownloadLink) {}

const f = schema.files;
type FileRow = typeof f.$inferSelect;
const toInfo = (row: FileRow) => ({
  id: row.id,
  filename: row.filename,
  mime: row.mime,
  size: row.size,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Direct-to-blob uploads: the API never streams file bytes. It records a pending file, hands the
 * browser a 10-minute write-only SAS for exactly that blob, then verifies the blob on /complete.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Post('uploads')
  @Roles('editor')
  @Idempotent()
  @ZodResponse({ status: 201, type: UploadTicketDto })
  async createUpload(@Req() req: FastifyRequest, @Body() body: CreateUploadDto) {
    const tenantId = tenantOf(req).id;
    const id = newId();
    const blobPath = StorageService.filePath(tenantId, id, body.filename);
    const row = await this.db.withTenantTx(async (tx) => {
      if (body.resourceId) {
        const [owner] = await tx
          .select({ id: schema.resources.id })
          .from(schema.resources)
          .where(eq(schema.resources.id, body.resourceId));
        if (!owner) throw problems.notFound('Resource not found.');
      }
      const [inserted] = await tx
        .insert(f)
        .values({
          id,
          tenantId,
          resourceId: body.resourceId ?? null,
          blobPath,
          filename: body.filename,
          mime: body.mime,
          size: body.size,
          purpose: body.purpose,
          uploadedBy: authOf(req).id,
        })
        .returning();
      return inserted!;
    });
    const { url, expiresAt } = await this.storage.signedUrl(blobPath, 'write', 10, {
      contentType: body.mime,
    });
    return {
      file: toInfo(row),
      uploadUrl: url,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': body.mime },
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Verify the blob landed, matches what was declared, and mark the file ready. */
  @Post(':id/complete')
  @Roles('editor')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: FileInfoDto })
  async complete(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string) {
    const tenantId = tenantOf(req).id;
    return this.db.withTenantTx(async (tx) => {
      const [row] = await tx.select().from(f).where(eq(f.id, id)).for('update');
      if (!row) throw problems.notFound();
      if (row.status === 'ready') return toInfo(row);
      const props = await this.storage.properties(row.blobPath);
      if (!props) throw problems.conflict('The upload has not finished yet.');
      if (props.size > row.size || props.size === 0) {
        await this.storage.delete(row.blobPath);
        throw problems.badRequest('Uploaded file size does not match the declared size.');
      }
      const [updated] = await tx
        .update(f)
        .set({ status: 'ready', size: props.size, checksum: props.md5 ?? null })
        .where(eq(f.id, id))
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'file.uploaded',
        entity: 'file',
        entityId: id,
        diff: { filename: row.filename, size: props.size, resourceId: row.resourceId },
      });
      return toInfo(updated!);
    });
  }

  /** A 5-minute read SAS. Viewers can only download attachments of published resources. */
  @Get(':id/download')
  @ZodResponse({ status: 200, type: DownloadLinkDto })
  async download(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string) {
    const role = authOf(req).role;
    const row = await this.db.withTenantTx(async (tx) => {
      const [hit] = await tx
        .select({ file: f, status: schema.resources.status })
        .from(f)
        .leftJoin(schema.resources, eq(schema.resources.id, f.resourceId))
        .where(and(eq(f.id, id), eq(f.status, 'ready')));
      return hit;
    });
    if (
      !row ||
      (row.status !== 'published' && row.file.purpose !== 'logo' && !canSeeUnpublished(role))
    ) {
      throw problems.notFound();
    }
    const { url, expiresAt } = await this.storage.signedUrl(row.file.blobPath, 'read', 5, {
      downloadName: row.file.filename,
    });
    return { url, expiresAt: expiresAt.toISOString() };
  }

  @Delete(':id')
  @Roles('editor')
  @HttpCode(204)
  async remove(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const tenantId = tenantOf(req).id;
    const path = await this.db.withTenantTx(async (tx) => {
      const [row] = await tx.delete(f).where(eq(f.id, id)).returning();
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'file.deleted',
        entity: 'file',
        entityId: id,
        diff: { filename: row.filename },
      });
      return row.blobPath;
    });
    await this.storage.delete(path);
  }
}
