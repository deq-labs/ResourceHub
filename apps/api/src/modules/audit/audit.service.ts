import { Injectable, type OnModuleInit } from '@nestjs/common';
import { schema, type PlatformAuditEntry, type Tx } from '@resourcehub/db';
import type { FastifyRequest } from 'fastify';
import { DbService } from '../../infra/db.service.js';

export interface AuditActor {
  actorId: string | null;
  impersonatorId: string | null;
  ip: string | null;
}

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string;
  diff?: Record<string, unknown>;
}

export function actorFrom(req: FastifyRequest): AuditActor {
  return {
    actorId: req.auth?.id ?? null,
    impersonatorId: req.auth?.impersonatorId ?? null,
    ip: req.ip,
  };
}

/** Keys that must never land in an audit diff. */
const REDACT = /token|secret|password|hash/i;

export function redact(
  diff: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!diff) return undefined;
  return Object.fromEntries(
    Object.entries(diff).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : v]),
  );
}

/**
 * Writes to the append-only audit log. Tenant events are written inside the caller's tenant
 * transaction, so they commit or roll back with the change they describe.
 */
@Injectable()
export class AuditService implements OnModuleInit {
  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    // Every withPlatformTx() writes an audit row before running, in the same transaction.
    this.db.setPlatformAuditSink((tx, entry) => this.recordPlatform(tx, entry));
  }

  async record(tx: Tx, tenantId: string, actor: AuditActor, entry: AuditEntry): Promise<void> {
    await tx.insert(schema.auditLog).values({
      tenantId,
      actorId: actor.actorId,
      impersonatorId: actor.impersonatorId,
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      diff: redact(entry.diff) ?? null,
      ip: actor.ip,
    });
  }

  private async recordPlatform(tx: Tx, entry: PlatformAuditEntry): Promise<void> {
    await tx.insert(schema.auditLog).values({
      tenantId: entry.tenantId ?? null,
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      diff:
        redact({
          ...(entry.diff ?? {}),
          ...(entry.reason ? { reason: entry.reason } : {}),
          platform: true,
        }) ?? null,
      ip: entry.ip ?? null,
    });
  }
}
