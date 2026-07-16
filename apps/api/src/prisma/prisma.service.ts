import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { getPrismaClient, withTenantContext, type Prisma, type PrismaClient } from "@rentos/database";

/**
 * Thin wrapper around the singleton Prisma client from @rentos/database.
 * `raw` is for the small set of legitimately tenant-agnostic queries
 * (resolving a Tenant by domain/slug — the tenants table has no tenant_id
 * column, see prisma schema comment). Everything else MUST go through
 * TenantContextService.run(), never `raw` directly, or RLS provides no
 * protection at all.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly raw: PrismaClient = getPrismaClient();

  async runInTenantContext<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return withTenantContext(this.raw, tenantId, fn);
  }

  async onModuleDestroy() {
    await this.raw.$disconnect();
  }
}
