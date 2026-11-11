-- Owner 2026-11-11: "delete" a unit type from Catalog Setup without breaking
-- the history that references it (bookings, rentals, invoices, ledger).
-- AlterTable
ALTER TABLE "asset_types" ADD COLUMN     "archived_at" TIMESTAMP(3);

