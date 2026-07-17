import { Module } from "@nestjs/common";

import { LocalDiskStorageProvider } from "./providers/local-disk.provider.js";
import { S3StorageProvider } from "./providers/s3.provider.js";
import { STORAGE_PROVIDER } from "./storage-provider.interface.js";

/** STORAGE_PROVIDER env var selects the adapter — defaults to local_disk so local dev/CI needs zero credentials. */
@Module({
  providers: [
    LocalDiskStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      useFactory: (local: LocalDiskStorageProvider, s3: S3StorageProvider) =>
        process.env.STORAGE_PROVIDER === "s3" ? s3 : local,
      inject: [LocalDiskStorageProvider, S3StorageProvider],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
