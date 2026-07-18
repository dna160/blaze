import { Global, Module } from "@nestjs/common";

import { WebhookDispatcherService } from "./webhook-dispatch.service.js";

@Global()
@Module({
  providers: [WebhookDispatcherService],
  exports: [WebhookDispatcherService],
})
export class WebhookDispatchModule {}
