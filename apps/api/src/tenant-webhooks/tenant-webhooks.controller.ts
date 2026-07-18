import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateWebhookSubscriptionRequestSchema, UpdateWebhookSubscriptionRequestSchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { TenantWebhooksService } from "./tenant-webhooks.service.js";

@ApiTags("tenant-webhooks")
@Controller("webhook-subscriptions")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("SUPER_ADMIN")
export class TenantWebhooksController {
  constructor(private readonly webhooks: TenantWebhooksService) {}

  @Post()
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateWebhookSubscriptionRequestSchema))
    body: ReturnType<typeof CreateWebhookSubscriptionRequestSchema.parse>,
  ) {
    return this.webhooks.create(tenant, user.id, body.url, body.eventTypes);
  }

  @Get()
  list(@CurrentTenant() tenant: ResolvedTenant) {
    return this.webhooks.list(tenant);
  }

  @Patch(":id")
  update(
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateWebhookSubscriptionRequestSchema))
    body: ReturnType<typeof UpdateWebhookSubscriptionRequestSchema.parse>,
  ) {
    return this.webhooks.update(tenant, id, body);
  }

  @Delete(":id")
  remove(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.webhooks.remove(tenant, id);
  }

  @Get(":id/deliveries")
  listDeliveries(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.webhooks.listDeliveries(tenant, id);
  }
}
