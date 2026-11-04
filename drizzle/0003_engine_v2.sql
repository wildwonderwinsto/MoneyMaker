CREATE TABLE "hidden_traders" (
	"wallet" text PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "paper_positions_account_id_token_id_source_wallet_index";--> statement-breakpoint
ALTER TABLE "paper_fills" ADD COLUMN "realized_pnl" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "kind" text DEFAULT 'copy' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "hedge_of" integer;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "paper_fills_signal_id_index" ON "paper_fills" USING btree ("signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_open_unique" ON "paper_positions" USING btree ("account_id","token_id","source_wallet","kind") WHERE "paper_positions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "paper_positions_hedge_of_index" ON "paper_positions" USING btree ("hedge_of");--> statement-breakpoint
CREATE INDEX "signals_decision_reason_code_index" ON "signals" USING btree ("decision","reason_code");