-- Post-implementation audit (P3): freeze the sponsor-override policy decision
-- at checkout so settings changes between checkout and payment confirmation
-- can never retroactively alter an in-flight order's compensation arrangement.
-- Additive, forward-only. NULL on legacy rows = fall back to the live setting
-- at posting time (historical behaviour preserved).

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "affiliateSponsorEnabled" BOOLEAN;
