import { Module } from "@nestjs/common";

import { ApiKeyGuard } from "./api-key.guard.js";
import { ExternalApiController } from "./external-api.controller.js";
import { ExternalApiService } from "./external-api.service.js";

@Module({
  controllers: [ExternalApiController],
  providers: [ExternalApiService, ApiKeyGuard],
})
export class ExternalApiModule {}
