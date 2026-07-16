import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";

import { ReportingService } from "./reporting.service.js";

@ApiTags("reporting")
@Controller("reports")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("occupancy")
  occupancy(@CurrentTenantId() tenantId: string) {
    return this.reporting.occupancy(tenantId);
  }

  @Get("ar-aging")
  arAging(@CurrentTenantId() tenantId: string) {
    return this.reporting.arAging(tenantId);
  }

  @Get("booking-funnel")
  bookingFunnel(@CurrentTenantId() tenantId: string) {
    return this.reporting.bookingFunnel(tenantId);
  }
}
