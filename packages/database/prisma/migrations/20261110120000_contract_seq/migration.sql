-- Owner 2026-11-10: invoice numbers carry the number of the contract they
-- belong to ({CONTRACT}); each contract stores the sequence it took.
-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "contract_seq" INTEGER;

