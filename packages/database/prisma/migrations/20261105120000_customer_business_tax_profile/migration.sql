-- Corporate customers: the business registration number, and whether they
-- withhold PPh on rent. Both nullable — every existing row is an individual,
-- and pph_withheld stays NULL until the customer actually answers, which is
-- deliberately distinct from an answered "no".
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "nib" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "pph_withheld" BOOLEAN;
