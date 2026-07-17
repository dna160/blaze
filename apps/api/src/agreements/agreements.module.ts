import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";
import { StorageModule } from "../storage/storage.module.js";

import { AgreementsController } from "./agreements.controller.js";
import { AgreementsService } from "./agreements.service.js";

@Module({
  imports: [StorageModule, BookingModule],
  controllers: [AgreementsController],
  providers: [AgreementsService],
  exports: [AgreementsService],
})
export class AgreementsModule {}
