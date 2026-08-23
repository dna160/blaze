import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module.js";

import { DocumentsService } from "./documents.service.js";

/** PRD v2 P9 — generated contract + proforma/invoice PDFs, stored via the existing StorageProvider port. */
@Module({
  imports: [StorageModule],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
