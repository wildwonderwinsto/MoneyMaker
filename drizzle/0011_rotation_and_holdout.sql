ALTER TABLE "traders" ADD COLUMN "first_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "markets_traded" integer;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "markets_at_check" integer;