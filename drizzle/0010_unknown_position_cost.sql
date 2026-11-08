-- Positions whose shares came from splits/conversions: the API sends total_size 0, which older
-- backfills stored as shares_bought 0 / total_cost 0 ("free"). Store them the way backfill now
-- does: the shares still held for a non-CLOSED row, else NULL (unknown cost, left out of
-- scoring). Data only, no schema change. Idempotent: touches only rows still at 0.
UPDATE "trader_positions"
SET
  "shares_bought" = CASE WHEN "status" <> 'CLOSED' AND "size" > 0 THEN "size" END,
  "total_cost" = CASE WHEN "status" <> 'CLOSED' AND "size" > 0 THEN "size" * "avg_price" END
WHERE "shares_bought" = 0;
