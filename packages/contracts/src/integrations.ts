import { z } from 'zod';

export const IntegrationProvider = z.object({
  provider: z.string(),
  kind: z.enum(['rest', 'soap']),
  label: z.string(),
  description: z.string(),
  needsSecret: z.boolean(),
  supportsPush: z.boolean(),
  defaults: z.record(z.string(), z.unknown()),
});
export const IntegrationProviderList = z.object({ data: z.array(IntegrationProvider) });

export const RunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);

export const IntegrationRun = z.object({
  id: z.uuid(),
  type: z.enum(['sync', 'push']),
  trigger: z.enum(['manual', 'schedule']),
  status: RunStatus,
  attempts: z.number().int(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  stats: z
    .object({
      fetched: z.number().optional(),
      created: z.number().optional(),
      updated: z.number().optional(),
      unchanged: z.number().optional(),
      pushedReference: z.string().optional(),
    })
    .nullable(),
  error: z.string().nullable(),
  traceId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type IntegrationRun = z.infer<typeof IntegrationRun>;
export const IntegrationRunList = z.object({ data: z.array(IntegrationRun) });

export const Integration = z.object({
  id: z.uuid(),
  kind: z.enum(['rest', 'soap']),
  provider: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  /** Where the secret lives (env:NAME / kv:name). The secret itself is never returned. */
  secretRef: z.string().nullable(),
  enabled: z.boolean(),
  scheduleMinutes: z.number().int().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  lastRun: IntegrationRun.nullable(),
  supportsPush: z.boolean(),
});
export type Integration = z.infer<typeof Integration>;
export const IntegrationList = z.object({ data: z.array(Integration) });

const SecretRef = z
  .string()
  .regex(/^(env:[A-Z][A-Z0-9_]{1,63}|kv:[a-zA-Z0-9-]{1,127})$/, 'env:NAME or kv:secret-name');

export const CreateIntegration = z.object({
  provider: z.string().min(1).max(60),
  name: z.string().trim().min(2).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  secretRef: SecretRef.nullable().optional(),
  scheduleMinutes: z.number().int().min(5).max(1440).nullable().optional(),
});
export type CreateIntegration = z.input<typeof CreateIntegration>;

export const UpdateIntegration = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secretRef: SecretRef.nullable().optional(),
  enabled: z.boolean().optional(),
  scheduleMinutes: z.number().int().min(5).max(1440).nullable().optional(),
});
export type UpdateIntegration = z.infer<typeof UpdateIntegration>;

export const ConnectionTest = z.object({
  ok: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  latencyMs: z.number().int(),
});

export const PushResource = z.object({ integrationId: z.uuid(), resourceId: z.uuid() });
