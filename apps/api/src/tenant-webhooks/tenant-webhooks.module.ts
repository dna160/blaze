import { Module } from "@nestjs/common";

import { TenantWebhooksController } from "./tenant-webhooks.controller.js";
import { TenantWebhooksService } from "./tenant-webhooks.service.js";

@Module({
  controllers: [TenantWebhooksController],
  providers: [TenantWebhooksService],
  exports: [TenantWebhooksService],
})
export class TenantWebhooksModule {}
