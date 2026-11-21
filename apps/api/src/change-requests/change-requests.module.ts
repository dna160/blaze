import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";

import { ChangeRequestsController } from "./change-requests.controller.js";
import { ChangeRequestsService } from "./change-requests.service.js";

/** PRD go-live 2 §4 — booking changes need approval. */
@Module({
  imports: [BookingModule],
  controllers: [ChangeRequestsController],
  providers: [ChangeRequestsService],
})
export class ChangeRequestsModule {}
