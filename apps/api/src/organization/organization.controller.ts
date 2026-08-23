import { Body, Controller, Get, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TestMessagingRequestSchema, UpdateMessagingConfigRequestSchema } from "@rentos/contracts";

import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

import { OrganizationService } from "./organization.service.js";

@ApiTags("organization")
@Controller("organization")
@UseGuards(JwtAuthGuard, StaffGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  /** Tenant switcher — the branches this staff user may act in / read (C1, #7). */
  @Get("branches")
  branches(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.listBranches(user);
  }

  /** B2 — HO cross-branch financial summary (read-only, org-scoped roles only). */
  @Get("financials")
  financials(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.financialSummary(user);
  }

  /** #45 — onboard a new empty branch under the org (org-scoped admin only). */
  @Post("branches")
  provision(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { slug: string; name: string; timezone?: string; isPkp?: boolean; primaryDomain?: string; locationAddress?: string },
  ) {
    return this.organization.provisionBranch(user, body);
  }

  /**
   * #40 — messaging setup for the whole organization. Reading is staff-wide
   * (the screen shows which number is in force and never the token); writing
   * and test-sending are manage_users, the same bucket as every other
   * org/tenant configuration surface.
   */
  @Get("messaging")
  messagingConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.getMessagingConfig(user);
  }

  @Put("messaging")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  updateMessagingConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateMessagingConfigRequestSchema)) body: ReturnType<typeof UpdateMessagingConfigRequestSchema.parse>,
  ) {
    return this.organization.updateMessagingConfig(user, body);
  }

  @Post("messaging/test")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  testMessaging(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(TestMessagingRequestSchema)) body: ReturnType<typeof TestMessagingRequestSchema.parse>,
  ) {
    return this.organization.testMessaging(user, body);
  }
}
