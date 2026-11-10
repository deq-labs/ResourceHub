import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { problems } from './problem.js';

export type HostScope = 'tenant' | 'platform' | 'any';
export const HOST_SCOPE = 'resourcehub:host-scope';

/** Routes default to `tenant`. Use `platform` for the admin host, `any` for health checks. */
export const ForHost = (scope: HostScope) => SetMetadata(HOST_SCOPE, scope);

/**
 * Runs before auth. On a tenant route, an unknown host is a 404 and a suspended tenant a 403,
 * so nothing (including auth) runs for hosts that don't map to an active tenant.
 */
@Injectable()
export class HostScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const scope =
      this.reflector.getAllAndOverride<HostScope | undefined>(HOST_SCOPE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'tenant';
    if (scope === 'any') return true;

    const { site } = context.switchToHttp().getRequest<FastifyRequest>();
    if (scope === 'platform') {
      if (site.kind !== 'platform') throw problems.notFound();
      return true;
    }
    if (site.kind !== 'tenant') throw problems.unknownHost();
    if (site.tenant.status !== 'active') throw problems.tenantSuspended();
    return true;
  }
}
