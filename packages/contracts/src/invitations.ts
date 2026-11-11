import { z } from 'zod';
import { Role } from './tenancy.js';

export const CreateInvitation = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: Role,
});
export type CreateInvitation = z.infer<typeof CreateInvitation>;

export const Invitation = z.object({
  id: z.uuid(),
  email: z.string(),
  role: Role,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invitedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof Invitation>;

/** Only returned once, at creation. The token itself is never stored. */
export const CreatedInvitation = Invitation.extend({
  acceptUrl: z.url(),
});
export type CreatedInvitation = z.infer<typeof CreatedInvitation>;

export const InvitationList = z.object({ data: z.array(Invitation) });
export type InvitationList = z.infer<typeof InvitationList>;

export const AcceptInvitation = z.object({
  token: z.string().min(20).max(200),
});
export type AcceptInvitation = z.infer<typeof AcceptInvitation>;

export const InvitationPreview = z.object({
  workspace: z.string(),
  role: Role,
  emailHint: z.string(),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;
