-- AlterTable
ALTER TABLE "swap_requests" ADD COLUMN     "proration_days_remaining" INTEGER,
ADD COLUMN     "proration_net_adjustment" DECIMAL(14,2);
