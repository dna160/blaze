import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { MasterAgreementService } from "./master-agreement.service.js";
import { OrderAcceptanceService } from "./order-acceptance.service.js";

@ApiTags("agreements")
@Controller()
export class MasterAgreementController {
  constructor(
    private readonly master: MasterAgreementService,
    private readonly acceptance: OrderAcceptanceService,
  ) {}

  /** §5 — create a master agreement (staff, once per customer). */
  @Post("master-agreements")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("create_booking")
  create(@CurrentTenant() tenant: ResolvedTenant, @Body() body: { customerId: string; templateVersion?: string }) {
    return this.master.create(tenant, body);
  }

  /** §5 — send the master for a certified signature (the only certified signature). */
  @Post("master-agreements/:id/send")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("create_booking")
  send(
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id") id: string,
    @Body() body: { name: string; phone: string; email?: string },
  ) {
    return this.master.sendForSignature(tenant, id, body);
  }

  @Get("master-agreements/:id")
  @UseGuards(JwtAuthGuard)
  get(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.master.get(tenant, id);
  }

  /**
   * §5 — customer accepts a monthly rental order via OTP against the SIGNED
   * master. Consumes NO certified signature. Records the evidence bundle
   * (timestamp, IP, device, OTP proof).
   */
  @Post("rental-orders/:orderId/accept")
  @UseGuards(JwtAuthGuard)
  accept(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Req() req: Request,
    @Body() body: { method?: "OTP" | "CLICK"; otpChallengeId?: string; proof?: Record<string, unknown> },
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.acceptance.recordAcceptance(tenant, orderId, {
      method: body.method ?? "OTP",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      otpChallengeId: body.otpChallengeId,
      proof: body.proof,
    });
  }

  /** §5 — export an order's acceptance evidence bundle (staff). */
  @Get("rental-orders/:orderId/acceptances")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("run_reports")
  acceptances(@CurrentTenant() tenant: ResolvedTenant, @Param("orderId") orderId: string) {
    return this.acceptance.listForOrder(tenant, orderId);
  }
}
