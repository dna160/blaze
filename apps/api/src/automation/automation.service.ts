import { ForbiddenException, Injectable } from "@nestjs/common";
import { DEFAULT_DUNNING_LADDER_CONFIG, type DunningLadderConfig, type UpdateAutomationSettingRequest } from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const KEY: "DUNNING_LADDER" = "DUNNING_LADDER";

/**
 * PRD Phase 4 "visual automation builder" (Session 26), scoped to the
 * dunning ladder — see packages/contracts/src/automation.ts's doc
 * comment for why this isn't a general rule engine. Gated by
 * featureFlags.automation_builder_enabled, same assertEnabled pattern as
 * ApiKeysService (Session 20) — on for gudang-aman only in the demo.
 */
@Injectable()
export class AutomationService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenant: ResolvedTenant) {
    this.assertEnabled(tenant);
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.automationSetting.findUnique({ where: { tenantId_key: { tenantId: tenant.id, key: KEY } } }),
    );
    if (!row) {
      return { key: KEY, enabled: false, config: DEFAULT_DUNNING_LADDER_CONFIG, isDefault: true, updatedAt: null };
    }
    return {
      key: KEY,
      enabled: row.enabled,
      config: row.config as unknown as DunningLadderConfig,
      isDefault: false,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async upsert(tenant: ResolvedTenant, dto: UpdateAutomationSettingRequest) {
    this.assertEnabled(tenant);
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.automationSetting.upsert({
        where: { tenantId_key: { tenantId: tenant.id, key: KEY } },
        update: { enabled: dto.enabled, config: dto.config },
        create: { tenantId: tenant.id, key: KEY, enabled: dto.enabled, config: dto.config },
      }),
    );
    return {
      key: KEY,
      enabled: row.enabled,
      config: row.config as unknown as DunningLadderConfig,
      isDefault: false,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private assertEnabled(tenant: ResolvedTenant) {
    if (!tenant.featureFlags.automation_builder_enabled) {
      throw new ForbiddenException("The automation builder is not enabled for this tenant.");
    }
  }
}
