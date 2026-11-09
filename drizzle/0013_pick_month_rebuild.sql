ALTER TABLE "monthly_selections" ADD COLUMN "coverage_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monthly_selections" ADD COLUMN "partial" boolean;--> statement-breakpoint
ALTER TABLE "monthly_selections" ADD COLUMN "bets" integer;--> statement-breakpoint
ALTER TABLE "monthly_selections" ADD COLUMN "staked" double precision;--> statement-breakpoint
ALTER TABLE "monthly_selections" ADD COLUMN "pnl" double precision;