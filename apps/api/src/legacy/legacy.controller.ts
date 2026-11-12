import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { LegacyImportRequestSchema, LegacyListQuerySchema } from "@rentos/contracts";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

import { LegacyService } from "./legacy.service.js";

/** The read-only archive of the previous system's records. Staff may read; only an org-scoped Admin may import. */
@ApiTags("legacy")
@Controller("legacy")
@UseGuards(JwtAuthGuard, StaffGuard)
export class LegacyController {
  constructor(private readonly legacy: LegacyService) {}

  @Post("records/import")
  importRecords(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenantId() tenantId: string,
    @Body(new ZodValidationPipe(LegacyImportRequestSchema)) body: ReturnType<typeof LegacyImportRequestSchema.parse>,
  ) {
    return this.legacy.importRecords(user, tenantId, body);
  }

  @Get("summary")
  summary(@CurrentTenantId() tenantId: string, @Query("customerNumber") customerNumber?: string) {
    const n = customerNumber ? Number(customerNumber) : undefined;
    return this.legacy.summary(tenantId, Number.isInteger(n) ? n : undefined);
  }

  @Get("records")
  list(@CurrentTenantId() tenantId: string, @Query(new ZodValidationPipe(LegacyListQuerySchema)) query: ReturnType<typeof LegacyListQuerySchema.parse>) {
    return this.legacy.list(tenantId, query);
  }

  @Get("records/:id")
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.legacy.get(tenantId, id);
  }
}
