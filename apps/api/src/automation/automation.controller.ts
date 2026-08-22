import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { UpdateAutomationSettingRequestSchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { AutomationService } from "./automation.service.js";

@ApiTags("automation")
@Controller("automation")
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapability("manage_users")
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get("dunning-ladder")
  get(@CurrentTenant() tenant: ResolvedTenant) {
    return this.automation.get(tenant);
  }

  @Patch("dunning-ladder")
  update(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(UpdateAutomationSettingRequestSchema))
    body: ReturnType<typeof UpdateAutomationSettingRequestSchema.parse>,
  ) {
    return this.automation.upsert(tenant, body);
  }
}
