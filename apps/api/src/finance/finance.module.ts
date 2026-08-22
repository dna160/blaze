import { Module } from "@nestjs/common";

import { DocumentsModule } from "../documents/documents.module.js";

import { FinanceController } from "./finance.controller.js";
import { FinanceService } from "./finance.service.js";

@Module({
  imports: [DocumentsModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
