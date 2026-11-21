import { Module } from "@nestjs/common";

import { CrmModule } from "../crm/crm.module.js";

import { ReportingController } from "./reporting.controller.js";
import { ReportingService } from "./reporting.service.js";

@Module({
  imports: [CrmModule],
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}
