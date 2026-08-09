import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
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
}
