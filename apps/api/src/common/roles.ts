import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { problems } from './problem.js';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export const MIN_ROLE = 'resourcehub:min-role';

/** Require at least this role in the current workspace, e.g. `@Roles('admin')` admits admins and owners. */
export const Roles = (min: Role) => SetMetadata(MIN_ROLE, min);

export function roleAtLeast(role: string | undefined, min: Role): boolean {
  return role !== undefined && Object.hasOwn(RANK, role) && RANK[role as Role] >= RANK[min];
}

export function outranksOrEquals(actor: string | undefined, target: Role): boolean {
  return roleAtLeast(actor, target);
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const min = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!min) return true;
    const { auth } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!roleAtLeast(auth?.role, min)) {
      throw problems.forbidden(`This action needs the ${min} role or higher.`);
    }
    return true;
  }
}
