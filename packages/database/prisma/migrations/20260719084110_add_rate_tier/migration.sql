-- CreateEnum
CREATE TYPE "RateTier" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "rate_tier" "RateTier" NOT NULL DEFAULT 'MONTHLY';
