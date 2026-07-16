import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set.");
    this.client = new Redis(url, { maxRetriesPerRequest: 3 });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
