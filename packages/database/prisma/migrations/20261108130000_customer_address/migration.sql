-- PRD go-live §7.1: the customer block on City Storage contracts and invoices
-- prints an address (the legacy Booqable export carries one per customer).
-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "address" TEXT;

