import type { FastifyRequest } from 'fastify';
import { problems } from './problem.js';
import type { AuthUser, ResolvedTenant } from './site.js';

/** The tenant of the current host. HostScopeGuard has already enforced this on tenant routes. */
export function tenantOf(req: FastifyRequest): ResolvedTenant {
  if (req.site.kind !== 'tenant') throw problems.unknownHost();
  return req.site.tenant;
}

export function authOf(req: FastifyRequest): AuthUser {
  if (!req.auth) throw problems.unauthorized();
  return req.auth;
}
