ALTER TABLE "trader_positions" ADD COLUMN "shares_bought" double precision;--> statement-breakpoint
ALTER TABLE "trader_positions" ADD COLUMN "first_entry_at" timestamp with time zone;