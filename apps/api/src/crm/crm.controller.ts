import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

import { CrmService } from "./crm.service.js";

@ApiTags("crm")
@Controller("customers")
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  /** PRD §7.1.4 customer portal profile — must be declared before :id so "me" isn't swallowed by the param route. */
  @Get("me")
  getMe(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.crm.getById(tenantId, user.id);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  list(@CurrentTenantId() tenantId: string) {
    return this.crm.listCustomers(tenantId);
  }

  @Get(":id")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getById(tenantId, id);
  }

  @Patch(":id/blocklist")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  setBlocklist(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: { isBlocklisted: boolean; reason?: string },
  ) {
    return this.crm.setBlocklist(tenantId, id, body.isBlocklisted, body.reason);
  }
}
