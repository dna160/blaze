import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { generateApiKey } from "./api-key.util.js";

const LIST_SELECT = { id: true, label: true, keyPrefix: true, lastUsedAt: true, revokedAt: true, createdAt: true } as const;

/**
 * Console-facing CRUD for TenantApiKey (PRD Phase 4 tenant-facing API,
 * gated by featureFlags.api_access_enabled — see docs/HANDOFF.md
 * Session 20). The plaintext key is generated here and returned exactly
 * once, at creation; only its SHA-256 hash is ever persisted. keyHash
 * itself is never returned to the client either (LIST_SELECT omits it) —
 * a SHA-256 hash of a high-entropy secret isn't practically invertible,
 * but there's no reason to widen the response beyond what the console UI
 * needs.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenant: ResolvedTenant, createdByUserId: string, label: string) {
    this.assertEnabled(tenant);
    const { plaintext, keyPrefix, keyHash } = generateApiKey();
    const record = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.tenantApiKey.create({ data: { tenantId: tenant.id, label, keyPrefix, keyHash, createdByUserId }, select: LIST_SELECT }),
    );
    return { ...record, key: plaintext };
  }

  list(tenant: ResolvedTenant) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.tenantApiKey.findMany({ select: LIST_SELECT, orderBy: { createdAt: "desc" } }),
    );
  }

  async revoke(tenant: ResolvedTenant, id: string) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const key = await tx.tenantApiKey.findUnique({ where: { id } });
      if (!key) throw new NotFoundException("API key not found.");
      if (key.revokedAt) throw new ConflictException("API key is already revoked.");
      return tx.tenantApiKey.update({ where: { id }, data: { revokedAt: new Date() }, select: LIST_SELECT });
    });
  }

  private assertEnabled(tenant: ResolvedTenant) {
    if (!tenant.featureFlags.api_access_enabled) {
      throw new ForbiddenException("External API access is not enabled for this tenant.");
    }
  }
}
