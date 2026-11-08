import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { UpdateBranchSettingsRequestSchema } from "@rentos/contracts";

import { CurrentTenant, CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { BranchService } from "./branch.service.js";

@ApiTags("branch")
@Controller("branch")
export class BranchController {
  constructor(private readonly branch: BranchService) {}

  /** Public — storefront branch page and portal payment instructions. Never includes hidden bank accounts. */
  @Get("profile")
  profile(@CurrentTenant() tenant: ResolvedTenant) {
    return this.branch.getPublicProfile(tenant.id);
  }

  /** Console Settings → Branch. Every staff role may read; editing is checked in the service. */
  @Get("settings")
  @UseGuards(JwtAuthGuard, StaffGuard)
  settings(@CurrentUser() user: AuthenticatedUser, @CurrentTenantId() tenantId: string) {
    return this.branch.getSettings(user, tenantId);
  }

  @Put("settings")
  @UseGuards(JwtAuthGuard, StaffGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenantId() tenantId: string,
    @Body(new ZodValidationPipe(UpdateBranchSettingsRequestSchema)) body: ReturnType<typeof UpdateBranchSettingsRequestSchema.parse>,
  ) {
    return this.branch.updateSettings(user, tenantId, body);
  }
}
