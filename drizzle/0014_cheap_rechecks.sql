CREATE TABLE "skill_evidence" (
	"wallet" text PRIMARY KEY NOT NULL,
	"holdout_from" timestamp with time zone NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "last_full_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traders" ADD COLUMN "full_check_due" boolean DEFAULT false NOT NULL;