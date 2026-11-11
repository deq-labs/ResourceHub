import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { runWithTenant } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/**
 * Puts the resolved tenant (and user) into AsyncLocalStorage for the rest of the request,
 * so DbService.withTenantTx() can SET LOCAL app.tenant_id without anyone passing it around.
 * The subscription itself runs inside the ALS scope, so the async handler inherits it.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (req.site.kind !== 'tenant') return next.handle();
    const tenantId = req.site.tenant.id;
    const userId = req.auth?.id ?? null;
    return new Observable((subscriber) =>
      runWithTenant({ tenantId, userId }, () => next.handle().subscribe(subscriber)),
    );
  }
}
