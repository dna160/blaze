import { Module } from "@nestjs/common";

import { MoneyRulesController } from "./money-rules.controller.js";
import { MoneyRulesService } from "./money-rules.service.js";

/** PRD go-live 2 §10.3 — T&C money rules. */
@Module({
  controllers: [MoneyRulesController],
  providers: [MoneyRulesService],
  exports: [MoneyRulesService],
})
export class MoneyRulesModule {}
