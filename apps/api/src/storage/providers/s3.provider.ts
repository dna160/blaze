import { Injectable } from "@nestjs/common";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { SaveObjectParams, SaveObjectResult, StorageProvider } from "../storage-provider.interface.js";

/**
 * S3-compatible adapter — works with real AWS S3 or any S3-compatible
 * endpoint (Cloudflare R2, MinIO, Backblaze B2) via S3_ENDPOINT. Coded
 * against the real SDK but requires S3_BUCKET/credentials to run; select
 * it with STORAGE_PROVIDER=s3 (see storage.module.ts). This is what real
 * KTP/selfie uploads MUST use in production — see local-disk.provider.ts
 * for why local disk isn't safe for that.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly name = "S3";

  private client(): S3Client {
    return new S3Client({
      region: process.env.S3_REGION ?? "auto",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: Boolean(process.env.S3_ENDPOINT), // required for most non-AWS S3-compatible endpoints
      credentials:
        process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  private bucket(): string {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error("S3_BUCKET is not configured — set STORAGE_PROVIDER=local_disk for local dev, or provide S3 credentials.");
    }
    return bucket;
  }

  async save(params: SaveObjectParams): Promise<SaveObjectResult> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: params.key,
        Body: params.buffer,
        ContentType: params.contentType,
        // KTP/selfie images are PII — encrypt at rest (PRD §10 Security). SSE-S3 by
        // default; swap to aws:kms + SSEKMSKeyId if the bucket requires a customer key.
        ServerSideEncryption: "AES256",
      }),
    );
    return { storageKey: params.key };
  }

  async read(storageKey: string) {
    const url = await getSignedUrl(
      this.client(),
      new GetObjectCommand({ Bucket: this.bucket(), Key: storageKey }),
      { expiresIn: 300 },
    );
    return { kind: "redirect" as const, url };
  }
}
