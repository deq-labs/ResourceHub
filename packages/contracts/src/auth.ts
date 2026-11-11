import { z } from 'zod';
import { Role } from './tenancy.js';

export const Workspace = z.object({
  tenantId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  role: Role,
});
export type Workspace = z.infer<typeof Workspace>;

export const SessionUser = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  /** Role in the workspace of the current host; null when signed in but not a member. */
  role: Role.nullable(),
  isPlatformAdmin: z.boolean(),
  /** Present while a platform admin is impersonating this user. */
  impersonatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type SessionUser = z.infer<typeof SessionUser>;

/** Returned by POST /auth/refresh. The access token lives in memory only, never localStorage. */
export const SessionResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  user: SessionUser,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const MeResponse = z.object({
  user: SessionUser,
  workspaces: z.array(Workspace),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateMe = z.object({
  name: z.string().trim().min(1).max(120),
});
export type UpdateMe = z.infer<typeof UpdateMe>;
