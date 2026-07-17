import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApproveSwapRequestSchema, CreateSwapRequestSchema, RejectSwapRequestSchema } from "@rentos/contracts";

import { BookingService } from "../booking/booking.service.js";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { TenantMatchGuard } from "../common/guards/tenant-match.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { SwapRequestsService } from "./swap-requests.service.js";

const STAFF_ROLES = new Set(["SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER"]);

@ApiTags("swap-requests")
@Controller("swap-requests")
@UseGuards(JwtAuthGuard)
export class SwapRequestsController {
  constructor(
    private readonly swapRequests: SwapRequestsService,
    private readonly booking: BookingService,
  ) {}

  /** PRD §7.1.4 self-service "request upgrade/downsize". */
  @Post()
  @UseGuards(TenantMatchGuard)
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateSwapRequestSchema)) body: ReturnType<typeof CreateSwapRequestSchema.parse>,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.swapRequests.create(tenant, user.id, body.bookingId, body.requestedAssetTypeId, body.reason);
  }

  /** Staff approval queue (PRD Appendix C: same roles as the booking approval workbench). */
  @Get()
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  listQueue(@CurrentTenant() tenant: ResolvedTenant, @Query("status") status?: string) {
    return this.swapRequests.listQueue(tenant.id, { status });
  }

  @Get("by-booking/:bookingId")
  async listForBooking(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
  ) {
    if (user.kind === "CUSTOMER") {
      const booking = await this.booking.getBooking(tenant.id, bookingId);
      if (booking.customerId !== user.id) throw new ForbiddenException("This booking does not belong to you.");
    } else if (!user.roles.some((r) => STAFF_ROLES.has(r))) {
      throw new ForbiddenException();
    }
    return this.swapRequests.listForBooking(tenant.id, bookingId);
  }

  @Post(":id/approve")
  @UseGuards(RolesGuard, TenantMatchGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  approve(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApproveSwapRequestSchema)) body: ReturnType<typeof ApproveSwapRequestSchema.parse>,
  ) {
    return this.swapRequests.approve(tenant, user.id, id, body.newAssetId);
  }

  @Post(":id/reject")
  @UseGuards(RolesGuard, TenantMatchGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  reject(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RejectSwapRequestSchema)) body: ReturnType<typeof RejectSwapRequestSchema.parse>,
  ) {
    return this.swapRequests.reject(tenant, user.id, id, body.reason);
  }
}
