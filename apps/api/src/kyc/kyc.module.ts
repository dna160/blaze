import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module.js";

import { KycController } from "./kyc.controller.js";
import { KycService } from "./kyc.service.js";

@Module({
  imports: [StorageModule],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
