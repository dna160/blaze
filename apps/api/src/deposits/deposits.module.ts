import { Module } from "@nestjs/common";

import { PaymentsModule } from "../payments/payments.module.js";

import { DepositsController } from "./deposits.controller.js";
import { DepositsService } from "./deposits.service.js";

@Module({
  imports: [PaymentsModule],
  controllers: [DepositsController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
