import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ConnectionTest,
  CreateIntegration,
  Integration,
  IntegrationList,
  IntegrationProviderList,
  IntegrationRun,
  IntegrationRunList,
  PushResource,
  UpdateIntegration,
} from '@resourcehub/contracts';
import { and, desc, eq, inArray, schema, type Tx } from '@resourcehub/db';
import {
  getProvider,
  IntegrationError,
  PROVIDERS,
  SecretResolver,
} from '@resourcehub/integrations';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { problems } from '../../common/problem.js';
import { authOf, tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { DbService } from '../../infra/db.service.js';
import { QueueService } from '../../infra/queue.service.js';
import { actorFrom, AuditService } from '../audit/audit.service.js';

class ProviderListDto extends createZodDto(IntegrationProviderList) {}
class IntegrationListDto extends createZodDto(IntegrationList) {}
class IntegrationDto extends createZodDto(Integration) {}
class CreateIntegrationDto extends createZodDto(CreateIntegration) {}
class UpdateIntegrationDto extends createZodDto(UpdateIntegration) {}
class RunDto extends createZodDto(IntegrationRun) {}
class RunListDto extends createZodDto(IntegrationRunList) {}
class ConnectionTestDto extends createZodDto(ConnectionTest) {}
class PushResourceDto extends createZodDto(PushResource) {}

const i = schema.integrations;
const runs = schema.integrationRuns;
type IntegrationRow = typeof i.$inferSelect;
type RunRow = typeof runs.$inferSelect;

const runDto = (r: RunRow) => ({
  id: r.id,
  type: r.type,
  trigger: r.trigger,
  status: r.status,
  attempts: r.attempts,
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  stats: r.stats ?? null,
  error: r.error,
  traceId: r.traceId,
  createdAt: r.createdAt.toISOString(),
});

const integrationDto = (row: IntegrationRow, lastRun: RunRow | undefined) => ({
  id: row.id,
  kind: row.kind,
  provider: row.provider,
  name: row.name,
  config: row.config,
  secretRef: row.secretRef,
  enabled: row.enabled,
  scheduleMinutes: row.scheduleMinutes,
  lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  lastRun: lastRun ? runDto(lastRun) : null,
  supportsPush: getProvider(row.provider)?.supportsPush ?? false,
});

function validateConfig(
  provider: string,
  config: Record<string, unknown>,
  secretRef: string | null | undefined,
) {
  const def = getProvider(provider);
  if (!def) throw problems.badRequest(`Unknown provider "${provider}".`);
  const parsed = def.configSchema.safeParse({ ...def.defaults, ...config });
  if (!parsed.success)
    throw problems.badRequest(
      `Invalid ${def.label} config: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
    );
  if (def.needsSecret && !secretRef)
    throw problems.badRequest(
      `${def.label} needs a secretRef (env:NAME locally, kv:name in Azure).`,
    );
  return { def, config: parsed.data };
}

/** Outside-system connections. Admins configure; syncs and pushes always run in the worker. */
@ApiTags('integrations')
@Controller('integrations')
@Roles('admin')
export class IntegrationsController {
  private readonly secrets: SecretResolver;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {
    this.secrets = new SecretResolver({
      keyVaultUrl: config.KEY_VAULT_URL,
      allowEnv: config.NODE_ENV !== 'production',
    });
  }

  @Get('providers')
  @ZodResponse({ status: 200, type: ProviderListDto })
  providers() {
    return {
      data: PROVIDERS.map((p) => ({
        provider: p.provider,
        kind: p.kind,
        label: p.label,
        description: p.description,
        needsSecret: p.needsSecret,
        supportsPush: p.supportsPush,
        defaults: p.defaults,
      })),
    };
  }

  private async lastRuns(tx: Tx, ids: string[]): Promise<Map<string, RunRow>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectDistinctOn([runs.integrationId])
      .from(runs)
      .where(inArray(runs.integrationId, ids))
      .orderBy(runs.integrationId, desc(runs.createdAt));
    return new Map(rows.map((r) => [r.integrationId, r]));
  }

  @Get()
  @ZodResponse({ status: 200, type: IntegrationListDto })
  async list() {
    return this.db.withTenantTx(async (tx) => {
      const rows = await tx.select().from(i).orderBy(i.createdAt);
      const last = await this.lastRuns(
        tx,
        rows.map((r) => r.id),
      );
      return { data: rows.map((r) => integrationDto(r, last.get(r.id))) };
    });
  }

  @Post()
  @Idempotent()
  @ZodResponse({ status: 201, type: IntegrationDto })
  async create(@Req() req: FastifyRequest, @Body() body: CreateIntegrationDto) {
    const { def, config } = validateConfig(body.provider, body.config, body.secretRef);
    const tenantId = tenantOf(req).id;
    const row = await this.db.withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(i)
        .values({
          tenantId,
          kind: def.kind,
          provider: def.provider,
          name: body.name,
          config,
          secretRef: body.secretRef ?? null,
          scheduleMinutes: body.scheduleMinutes ?? null,
          createdBy: authOf(req).id,
        })
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'integration.created',
        entity: 'integration',
        entityId: created!.id,
        diff: { provider: def.provider, name: body.name, secretRef: body.secretRef ?? null },
      });
      return created!;
    });
    if (row.scheduleMinutes) await this.queue.upsertSchedule(tenantId, row.id, row.scheduleMinutes);
    return integrationDto(row, undefined);
  }

  @Patch(':id')
  @ZodResponse({ status: 200, type: IntegrationDto })
  async update(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIntegrationDto,
  ) {
    const tenantId = tenantOf(req).id;
    const row = await this.db.withTenantTx(async (tx) => {
      const [current] = await tx.select().from(i).where(eq(i.id, id)).for('update');
      if (!current) throw problems.notFound();
      const secretRef = body.secretRef !== undefined ? body.secretRef : current.secretRef;
      const { config } = validateConfig(current.provider, body.config ?? current.config, secretRef);
      const [updated] = await tx
        .update(i)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.scheduleMinutes !== undefined ? { scheduleMinutes: body.scheduleMinutes } : {}),
          config,
          secretRef,
        })
        .where(eq(i.id, id))
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'integration.updated',
        entity: 'integration',
        entityId: id,
        diff: { fields: Object.keys(body) },
      });
      return updated!;
    });
    if (row.enabled && row.scheduleMinutes)
      await this.queue.upsertSchedule(tenantId, id, row.scheduleMinutes);
    else await this.queue.removeSchedule(id);
    const last = await this.db.withTenantTx((tx) => this.lastRuns(tx, [id]));
    return integrationDto(row, last.get(id));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const tenantId = tenantOf(req).id;
    await this.db.withTenantTx(async (tx) => {
      const [row] = await tx.delete(i).where(eq(i.id, id)).returning({ name: i.name });
      if (!row) throw problems.notFound();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'integration.deleted',
        entity: 'integration',
        entityId: id,
        diff: { name: row.name },
      });
    });
    await this.queue.removeSchedule(id);
  }

  /** A quick reachability/credentials check. Not a sync, so it may run inside the request. */
  @Post(':id/test')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: ConnectionTestDto })
  async test(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.withTenantTx(
      async (tx) => (await tx.select().from(i).where(eq(i.id, id)))[0],
    );
    if (!row) throw problems.notFound();
    const def = getProvider(row.provider);
    if (!def) throw problems.badRequest('Unknown provider.');
    const started = Date.now();
    try {
      const secret = await this.secrets.resolve(row.secretRef);
      const res = await def
        .create({ retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
        .testConnection({ ...row.config, ...(secret ? { secret } : {}) });
      return {
        ok: res.ok,
        code: res.ok ? null : res.error.code,
        message: res.ok ? null : res.error.message,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      const ie =
        e instanceof IntegrationError
          ? e
          : new IntegrationError('config', 'Could not run the test', false);
      return { ok: false, code: ie.code, message: ie.message, latencyMs: Date.now() - started };
    }
  }

  /** Queue a sync. Returns the run row immediately (202-style); poll /runs for progress. */
  @Post(':id/sync')
  @Idempotent()
  @ZodResponse({ status: 201, type: RunDto })
  async sync(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string) {
    const tenantId = tenantOf(req).id;
    const run = await this.db.withTenantTx(async (tx) => {
      const [row] = await tx.select().from(i).where(eq(i.id, id));
      if (!row) throw problems.notFound();
      if (!row.enabled) throw problems.conflict('This integration is disabled.');
      const [created] = await tx
        .insert(runs)
        .values({
          tenantId,
          integrationId: id,
          type: 'sync',
          trigger: 'manual',
          requestedBy: authOf(req).id,
          traceId: req.id,
        })
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'integration.sync_requested',
        entity: 'integration',
        entityId: id,
        diff: { runId: created!.id },
      });
      return created!;
    });
    await this.queue.enqueueSync({
      type: 'sync',
      tenantId,
      integrationId: id,
      runId: run.id,
      trigger: 'manual',
      requestedBy: authOf(req).id,
    });
    return runDto(run);
  }

  @Get(':id/runs')
  @ZodResponse({ status: 200, type: RunListDto })
  async runs(@Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.withTenantTx((tx) =>
      tx
        .select()
        .from(runs)
        .where(eq(runs.integrationId, id))
        .orderBy(desc(runs.createdAt))
        .limit(25),
    );
    return { data: rows.map(runDto) };
  }

  /** Send a hub resource to a partner that supports push (e.g. SOAP SubmitDocument). */
  @Post('push')
  @Roles('editor')
  @Idempotent()
  @ZodResponse({ status: 201, type: RunDto })
  async push(@Req() req: FastifyRequest, @Body() body: PushResourceDto) {
    const tenantId = tenantOf(req).id;
    const { resourceId } = body;
    const run = await this.db.withTenantTx(async (tx) => {
      const [row] = await tx
        .select()
        .from(i)
        .where(and(eq(i.id, body.integrationId), eq(i.enabled, true)));
      if (!row) throw problems.notFound('Integration not found.');
      if (!getProvider(row.provider)?.supportsPush)
        throw problems.badRequest('This integration cannot receive pushes.');
      const [res] = await tx
        .select({ id: schema.resources.id })
        .from(schema.resources)
        .where(eq(schema.resources.id, resourceId));
      if (!res) throw problems.notFound('Resource not found.');
      const [created] = await tx
        .insert(runs)
        .values({
          tenantId,
          integrationId: row.id,
          type: 'push',
          trigger: 'manual',
          requestedBy: authOf(req).id,
          traceId: req.id,
        })
        .returning();
      await this.audit.record(tx, tenantId, actorFrom(req), {
        action: 'integration.push_requested',
        entity: 'resource',
        entityId: resourceId,
        diff: { integrationId: row.id, runId: created!.id },
      });
      return created!;
    });
    await this.queue.enqueueSync({
      type: 'push',
      tenantId,
      integrationId: body.integrationId,
      runId: run.id,
      trigger: 'manual',
      resourceId,
      requestedBy: authOf(req).id,
    });
    return runDto(run);
  }
}
