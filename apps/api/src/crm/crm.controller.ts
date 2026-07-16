import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";

import { CrmService } from "./crm.service.js";

@ApiTags("crm")
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get()
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  list(@CurrentTenantId() tenantId: string) {
    return this.crm.listCustomers(tenantId);
  }

  @Get(":id")
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getById(tenantId, id);
  }

  @Patch(":id/blocklist")
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  setBlocklist(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: { isBlocklisted: boolean; reason?: string },
  ) {
    return this.crm.setBlocklist(tenantId, id, body.isBlocklisted, body.reason);
  }
}
