import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { WaitlistService } from "./waitlist.service.js";

@ApiTags("waitlist")
@Controller("waitlist")
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  /** Staff arm a reviewed, KYC-verified customer onto the queue (C5). */
  @Post("arm")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("create_booking")
  arm(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body() body: { customerId: string; assetTypeId: string },
  ) {
    return this.waitlist.arm(tenant, body);
  }

  @Get(":assetTypeId")
  @UseGuards(JwtAuthGuard, StaffGuard)
  queue(@CurrentTenant() tenant: ResolvedTenant, @Param("assetTypeId") assetTypeId: string) {
    return this.waitlist.listQueue(tenant, assetTypeId);
  }

  /** Manual fire on a released unit (B10 — an SPV is enough). Normally automatic. */
  @Post("fire/:assetId")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("fire_waitlist")
  fire(@CurrentTenant() tenant: ResolvedTenant, @Param("assetId") assetId: string) {
    return this.waitlist.fireNext(tenant, assetId);
  }
}
