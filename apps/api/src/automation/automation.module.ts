import { Module } from "@nestjs/common";

import { AutomationController } from "./automation.controller.js";
import { AutomationService } from "./automation.service.js";

@Module({
  controllers: [AutomationController],
  providers: [AutomationService],
})
export class AutomationModule {}
