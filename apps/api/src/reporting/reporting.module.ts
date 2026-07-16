import { Module } from "@nestjs/common";

import { ReportingController } from "./reporting.controller.js";
import { ReportingService } from "./reporting.service.js";

@Module({
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}
