ALTER TABLE "traders" ADD COLUMN "trade_count" bigint;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "best_rank" integer;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "leaderboard_category" text;