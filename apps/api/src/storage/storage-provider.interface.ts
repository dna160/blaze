/**
 * Object storage port (PRD §10 Security: "encrypted PII at rest" for KTP
 * numbers/documents). Same shape as PaymentProvider/MessagingProvider —
 * one interface, swap the DI binding in storage.module.ts, zero call-site
 * changes. LocalDiskStorageProvider is the zero-config default; S3StorageProvider
 * is coded against the real AWS SDK but unconfigured until real bucket
 * credentials are supplied.
 */
export interface SaveObjectParams {
  key: string;
  buffer: Buffer;
  contentType: string;
}

export interface SaveObjectResult {
  storageKey: string;
}

export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");

export interface StorageProvider {
  readonly name: string;
  save(params: SaveObjectParams): Promise<SaveObjectResult>;
  /** Returns bytes for local streaming (LocalDisk) or a short-lived presigned GET URL to redirect to (S3). Callers handle both shapes via `kind`. */
  read(storageKey: string): Promise<{ kind: "buffer"; buffer: Buffer; contentType: string } | { kind: "redirect"; url: string }>;
}
