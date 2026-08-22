import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AgreementsModule } from "./agreements/agreements.module.js";
import { ApiKeysModule } from "./api-keys/api-keys.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { AutomationModule } from "./automation/automation.module.js";
import { BookingModule } from "./booking/booking.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter.js";
import { TenantMiddleware } from "./common/middleware/tenant.middleware.js";
import { RedisModule } from "./common/redis/redis.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { DepositsModule } from "./deposits/deposits.module.js";
import { ExternalApiModule } from "./external-api/external-api.module.js";
import { FinanceModule } from "./finance/finance.module.js";
import { HealthController } from "./health/health.controller.js";
import { KycModule } from "./kyc/kyc.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { OrganizationModule } from "./organization/organization.module.js";
import { OtaSyncModule } from "./ota-sync/ota-sync.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { PlatformModule } from "./platform/platform.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RentalOrderModule } from "./rental-order/rental-order.module.js";
import { ReportingModule } from "./reporting/reporting.module.js";
import { SwapRequestsModule } from "./swap-requests/swap-requests.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";
import { TenantWebhooksModule } from "./tenant-webhooks/tenant-webhooks.module.js";
import { UsersModule } from "./users/users.module.js";
import { WaitlistModule } from "./waitlist/waitlist.module.js";
import { WebhookDispatchModule } from "./webhook-dispatch/webhook-dispatch.module.js";

@Module({
  imports: [
    PrismaModule,
    TenancyModule,
    RedisModule,
    WebhookDispatchModule,
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
    UsersModule,
    ReportingModule,
    SwapRequestsModule,
    ApiKeysModule,
    TenantWebhooksModule,
    ExternalApiModule,
    OtaSyncModule,
    PlatformModule,
    AutomationModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
