import { Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SaveObjectParams, SaveObjectResult, StorageProvider } from "../storage-provider.interface.js";

/**
 * Dev/demo default — writes to local disk under UPLOAD_DIR. Zero external
 * credentials required, matching the rest of this codebase's mock/local
 * defaults (MockPaymentProvider, ConsoleLogMessagingProvider).
 *
 * NOT production-safe on Railway as-is: container filesystems are
 * ephemeral across deploys/restarts unless a persistent Volume is
 * explicitly mounted at UPLOAD_DIR. This is fine for local dev and for a
 * demo, but real KTP/selfie images MUST go to S3StorageProvider (or a
 * Railway Volume, if one is mounted) before this touches production PII.
 * See docs/HANDOFF.md.
 */
@Injectable()
export class LocalDiskStorageProvider implements StorageProvider {
  readonly name = "LOCAL_DISK";
  private readonly root = process.env.UPLOAD_DIR ?? "/tmp/rentos-uploads";

  async save(params: SaveObjectParams): Promise<SaveObjectResult> {
    const filePath = join(this.root, params.key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, params.buffer);
    await writeFile(`${filePath}.meta.json`, JSON.stringify({ contentType: params.contentType }));
    return { storageKey: params.key };
  }

  async read(storageKey: string) {
    const filePath = join(this.root, storageKey);
    try {
      const [buffer, metaRaw] = await Promise.all([readFile(filePath), readFile(`${filePath}.meta.json`, "utf-8")]);
      const meta = JSON.parse(metaRaw) as { contentType: string };
      return { kind: "buffer" as const, buffer, contentType: meta.contentType };
    } catch {
      throw new NotFoundException("Document not found.");
    }
  }
}
