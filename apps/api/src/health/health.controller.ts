import { Controller, Get } from "@nestjs/common";

/** Railway healthcheck target (see apps/api/railway.toml) — deliberately outside tenant resolution. */
@Controller("health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok", service: "rentos-api", timestamp: new Date().toISOString() };
  }
}
