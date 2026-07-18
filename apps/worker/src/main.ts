import { createServer } from "node:http";

import { createRedisConnection, scheduleRepeatableJobs, startWorkers } from "./queues.js";

async function main() {
  const connection = createRedisConnection();
  await scheduleRepeatableJobs(connection);
  const workers = startWorkers(connection);
  console.log("RentOS worker started — invoice-generation, dunning-ladder, ledger-balance-check, and tenant-webhook-delivery queues active.");

  // Railway healthcheck target — the worker has no HTTP API, but Railway's
  // Dockerfile-builder services still expect a TCP healthcheck endpoint.
  const port = Number(process.env.PORT ?? 4100);
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "rentos-worker" }));
  }).listen(port, "0.0.0.0", () => console.log(`Worker healthcheck listening on :${port}`));

  const shutdown = async () => {
    console.log("Shutting down worker...");
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
