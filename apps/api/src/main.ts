import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn", "log"],
  });

  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? "*").split(","), credentials: true });
  app.setGlobalPrefix("api");

  const config = new DocumentBuilder()
    .setTitle("RentOS API")
    .setDescription("Multi-tenant rental operations platform — see docs/PRD.md")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  Logger.log(`RentOS API listening on :${port}`, "Bootstrap");
}

bootstrap();
