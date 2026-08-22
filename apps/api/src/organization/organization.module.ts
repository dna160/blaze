import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module.js";

import { OrganizationController } from "./organization.controller.js";
import { OrganizationService } from "./organization.service.js";

@Module({
  imports: [PrismaModule],
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
