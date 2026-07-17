import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";

import { SwapRequestsController } from "./swap-requests.controller.js";
import { SwapRequestsService } from "./swap-requests.service.js";

@Module({
  imports: [BookingModule],
  controllers: [SwapRequestsController],
  providers: [SwapRequestsService],
})
export class SwapRequestsModule {}
