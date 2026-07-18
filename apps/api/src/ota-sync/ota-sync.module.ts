import { Module } from "@nestjs/common";

import { OtaSyncController } from "./ota-sync.controller.js";
import { OtaSyncService } from "./ota-sync.service.js";

@Module({
  controllers: [OtaSyncController],
  providers: [OtaSyncService],
  exports: [OtaSyncService],
})
export class OtaSyncModule {}
