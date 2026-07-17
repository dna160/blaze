import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { DepositsService } from "./deposits.service.js";

@ApiTags("deposits")
@Controller("deposits")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get("by-booking/:bookingId")
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  listForBooking(@CurrentTenant() tenant: ResolvedTenant, @Param("bookingId") bookingId: string) {
    return this.deposits.listForBooking(tenant.id, bookingId);
  }

  /** PRD Appendix C RBAC: refund requests can be initiated by ops as part of move-out. */
  @Post(":id/request-refund")
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN")
  requestRefund(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.deposits.requestRefund(tenant, id);
  }

  /** PRD Appendix C RBAC: "Issue credit notes / refunds" — Super Admin, Finance Admin only. */
  @Post(":id/approve-refund")
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN")
  approveRefund(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.deposits.approveRefund(tenant, user.id, id);
  }
}
