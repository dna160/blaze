import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module.js";

import { BranchController } from "./branch.controller.js";
import { BranchService } from "./branch.service.js";

@Module({
  imports: [PrismaModule],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}
