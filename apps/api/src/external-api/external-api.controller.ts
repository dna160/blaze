import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ExternalListQuerySchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ApiKeyGuard } from "./api-key.guard.js";
import { ExternalApiService } from "./external-api.service.js";

/** PRD Phase 4 tenant-facing read API — Bearer TenantApiKey auth, see ApiKeyGuard. */
@ApiTags("external-api")
@Controller("external")
@UseGuards(ApiKeyGuard)
export class ExternalApiController {
  constructor(private readonly externalApi: ExternalApiService) {}

  @Get("bookings")
  listBookings(
    @CurrentTenant() tenant: ResolvedTenant,
    @Query(new ZodValidationPipe(ExternalListQuerySchema)) query: ReturnType<typeof ExternalListQuerySchema.parse>,
  ) {
    return this.externalApi.listBookings(tenant, query);
  }

  @Get("invoices")
  listInvoices(
    @CurrentTenant() tenant: ResolvedTenant,
    @Query(new ZodValidationPipe(ExternalListQuerySchema)) query: ReturnType<typeof ExternalListQuerySchema.parse>,
  ) {
    return this.externalApi.listInvoices(tenant, query);
  }
}
