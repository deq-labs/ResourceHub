import { z } from 'zod';

export const Role = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type Role = z.infer<typeof Role>;

export const CurrentTenant = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
});
export type CurrentTenant = z.infer<typeof CurrentTenant>;
