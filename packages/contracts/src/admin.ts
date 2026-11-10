import { z } from 'zod';
import { Role } from './tenancy.js';

// ---- tenant admin ------------------------------------------------------------------------

export const Member = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type Member = z.infer<typeof Member>;
export const MemberList = z.object({ data: z.array(Member) });

export const UpdateMember = z.object({ role: Role });
export type UpdateMember = z.infer<typeof UpdateMember>;

export const AuditEntry = z.object({
  id: z.uuid(),
  action: z.string(),
  entity: z.string().nullable(),
  entityId: z.string().nullable(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  impersonator: z.object({ id: z.string() }).nullable(),
  diff: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({ data: z.array(AuditEntry), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  'filter[action]': z.string().max(60).optional(),
  'filter[actor]': z.uuid().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

// ---- platform admin (admin host only) ----------------------------------------------------

export const TenantStatus = z.enum(['active', 'suspended']);
export const TenantPlan = z.enum(['free', 'pro', 'enterprise']);

export const PlatformTenant = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: TenantStatus,
  plan: TenantPlan,
  createdAt: z.iso.datetime(),
  memberCount: z.number().int(),
  resourceCount: z.number().int(),
  domains: z.array(z.object({ hostname: z.string(), verified: z.boolean() })),
});
export type PlatformTenant = z.infer<typeof PlatformTenant>;
export const PlatformTenantList = z.object({ data: z.array(PlatformTenant) });

export const CreateTenant = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, numbers and dashes'),
  name: z.string().trim().min(2).max(80),
  plan: TenantPlan.default('free'),
  ownerEmail: z.email().transform((e) => e.toLowerCase()),
});
export type CreateTenant = z.input<typeof CreateTenant>;

export const CreatedTenant = z.object({
  tenant: PlatformTenant,
  url: z.string(),
  ownerInviteUrl: z.string(),
});
export type CreatedTenant = z.infer<typeof CreatedTenant>;

export const UpdateTenant = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  status: TenantStatus.optional(),
  plan: TenantPlan.optional(),
});
export type UpdateTenant = z.infer<typeof UpdateTenant>;

export const PlatformMemberList = z.object({
  data: z.array(z.object({ userId: z.uuid(), name: z.string(), email: z.string(), role: Role })),
});

export const StartImpersonation = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(300),
});
export type StartImpersonation = z.infer<typeof StartImpersonation>;

/** A one-time, 60-second hand-off URL on the tenant's host. */
export const ImpersonationTicket = z.object({ url: z.string(), expiresAt: z.iso.datetime() });
export type ImpersonationTicket = z.infer<typeof ImpersonationTicket>;

export const PlatformAuditEntry = AuditEntry.extend({
  tenant: z.object({ id: z.uuid(), slug: z.string() }).nullable(),
});
export const PlatformAuditPage = z.object({
  data: z.array(PlatformAuditEntry),
  nextCursor: z.string().nullable(),
});
