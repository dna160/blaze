-- CreateEnum
CREATE TYPE "KycVerificationSource" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "kyc_documents" ADD COLUMN     "provider_reason" TEXT,
ADD COLUMN     "provider_ref" TEXT,
ADD COLUMN     "verification_source" "KycVerificationSource" NOT NULL DEFAULT 'MANUAL';
