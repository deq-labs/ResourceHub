/** What the Host header resolved to. Set by the tenant-resolution hook before any auth runs. */
export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
}

export type Site =
  | { kind: 'tenant'; tenant: ResolvedTenant; host: string }
  | { kind: 'platform'; host: string }
  | { kind: 'none'; host: string };

/** Authenticated principal, set by the auth guard from the access JWT. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  memberships: { tenantId: string; role: string }[];
  /** Role in the tenant of the current host, if any. */
  role?: string;
  /** Platform admin acting as this user (impersonation), if any. */
  impersonatorId?: string;
  impersonatorName?: string;
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    site: Site;
    auth?: AuthUser;
  }
}
