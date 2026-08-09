import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AgreementsModule } from "./agreements/agreements.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { BookingModule } from "./booking/booking.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter.js";
import { TenantMiddleware } from "./common/middleware/tenant.middleware.js";
import { RedisModule } from "./common/redis/redis.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { DepositsModule } from "./deposits/deposits.module.js";
import { FinanceModule } from "./finance/finance.module.js";
import { HealthController } from "./health/health.controller.js";
import { KycModule } from "./kyc/kyc.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { OrganizationModule } from "./organization/organization.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RentalOrderModule } from "./rental-order/rental-order.module.js";
import { ReportingModule } from "./reporting/reporting.module.js";
import { SwapRequestsModule } from "./swap-requests/swap-requests.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";
import { WaitlistModule } from "./waitlist/waitlist.module.js";

@Module({
  imports: [
    PrismaModule,
    TenancyModule,
    RedisModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    CrmModule,
    BookingModule,
    AgreementsModule,
    FinanceModule,
    PaymentsModule,
    DepositsModule,
    KycModule,
    NotificationsModule,
    OrganizationModule,
    RentalOrderModule,
    WaitlistModule,
    ReportingModule,
    SwapRequestsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
