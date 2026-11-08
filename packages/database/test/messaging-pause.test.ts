import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PRD go-live §9.1 — "a new trigger cannot bypass the pause". Every file
 * that hands a message to a provider must also consult `outboundBlock`.
 * This scans the apps' sources for the send call shapes the codebase uses,
 * so adding a sender without the check fails CI rather than a go-live.
 */
const ROOT = path.resolve(__dirname, "../../..");
const SCAN = ["apps/api/src", "apps/worker/src"];
// Adapters themselves (they ARE the provider) and the console test send,
// which goes to a number staff type in and is not persisted.
const EXEMPT = [/apps\/api\/src\/notifications\/providers\//];
const SEND_CALL = /(providers\[[^\]]+\]\.(send|sendText)\(|waBridgeSendText\(|this\.email\.send\()/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("messaging pause coverage", () => {
  const senders = SCAN.flatMap((d) => walk(path.join(ROOT, d)))
    .filter((f) => !EXEMPT.some((re) => re.test(f)))
    .filter((f) => SEND_CALL.test(readFileSync(f, "utf8")));

  it("finds the known senders", () => {
    const rel = senders.map((f) => path.relative(ROOT, f)).sort();
    expect(rel).toEqual(
      expect.arrayContaining([
        "apps/api/src/messaging/messaging.service.ts",
        "apps/api/src/notifications/notifications.service.ts",
        "apps/api/src/notifications/whatsapp-webhook.service.ts",
        "apps/worker/src/notify.ts",
      ]),
    );
  });

  it.each(SCAN.flatMap((d) => walk(path.join(ROOT, d))).filter((f) => !EXEMPT.some((re) => re.test(f)) && SEND_CALL.test(readFileSync(f, "utf8"))).map((f) => [path.relative(ROOT, f)]))(
    "%s checks outboundBlock before sending",
    (rel) => {
      expect(readFileSync(path.join(ROOT, rel), "utf8")).toContain("outboundBlock(");
    },
  );
});
