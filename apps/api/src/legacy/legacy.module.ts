import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module.js";

import { LegacyController } from "./legacy.controller.js";
import { LegacyService } from "./legacy.service.js";

@Module({
  imports: [PrismaModule],
  controllers: [LegacyController],
  providers: [LegacyService],
})
export class LegacyModule {}
