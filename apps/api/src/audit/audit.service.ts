import { Injectable } from "@nestjs/common";
import type { Prisma } from "@rentos/database";

import { PrismaService } from "../prisma/prisma.service.js";

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * "Immutable audit log of all admin actions... protects the owner from
 * his own staff" (PRD §7.2.7). Called explicitly from services at the
 * point of mutation rather than inferred generically from a decorator —
 * an audit trail that might silently miss an action because a decorator
 * was forgotten is worse than one that requires an explicit call per
 * mutation.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.runInTenantContext(entry.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
          ipAddress: entry.ipAddress ?? null,
        },
      }),
    );
  }
}
