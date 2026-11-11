import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { from, Observable, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { REDIS } from '../tokens.js';
import { TenantScopedCache } from '../infra/tenant-cache.js';
import { ProblemException, problems } from './problem.js';

const IDEMPOTENT = 'resourcehub:idempotent';
const TTL_SECONDS = 24 * 60 * 60;
const LOCK_SECONDS = 60;
const KEY_RE = /^[\w-]{8,128}$/;

interface Stored {
  state: 'pending' | 'done';
  status?: number;
  body?: unknown;
  fingerprint: string;
}

/**
 * `Idempotency-Key` on POSTs that create something or trigger a sync. A retried request with the
 * same key replays the first response; a concurrent duplicate gets 409; reusing a key with a
 * different body gets 422. Keys are scoped per tenant and per user.
 */
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT, true),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: '8-128 chars [A-Za-z0-9_-]',
    }),
  );

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, context.getHandler())) return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY_RE.test(key))
      throw problems.badRequest('An Idempotency-Key header is required.');
    if (req.site.kind !== 'tenant' && req.site.kind !== 'platform') throw problems.unknownHost();

    const scope =
      req.site.kind === 'tenant' ? req.site.tenant.id : '00000000-0000-0000-0000-000000000000';
    const cacheKey = TenantScopedCache.key(scope, `idem:${req.auth?.id ?? 'anon'}:${key}`);
    const fingerprint = createHash('sha256')
      .update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    return from(
      this.redis.set(
        cacheKey,
        JSON.stringify({ state: 'pending', fingerprint } satisfies Stored),
        'EX',
        LOCK_SECONDS,
        'NX',
      ),
    ).pipe(
      switchMap((acquired) => {
        if (acquired === 'OK') {
          return next.handle().pipe(
            tap((body) => {
              const stored: Stored = { state: 'done', status: reply.statusCode, body, fingerprint };
              void this.redis.set(cacheKey, JSON.stringify(stored), 'EX', TTL_SECONDS);
            }),
            catchError((err: unknown) => {
              // Failed attempts don't burn the key; the client can retry.
              void this.redis.del(cacheKey);
              return throwError(() => err);
            }),
          );
        }
        return from(this.redis.get(cacheKey)).pipe(
          switchMap((raw) => {
            const prior = raw ? (JSON.parse(raw) as Stored) : undefined;
            if (!prior || prior.state === 'pending') {
              throw new ProblemException(
                409,
                'idempotency-in-progress',
                'Request in progress',
                'A request with this Idempotency-Key is still running.',
              );
            }
            if (prior.fingerprint !== fingerprint) {
              throw new ProblemException(
                422,
                'idempotency-mismatch',
                'Idempotency-Key reused',
                'This key was used with a different request.',
              );
            }
            void reply.status(prior.status ?? 200).header('idempotent-replayed', 'true');
            return of(prior.body);
          }),
        );
      }),
    );
  }
}
