CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"params" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"strategy_curve" jsonb NOT NULL,
	"baseline_curve" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"wallet" text PRIMARY KEY NOT NULL,
	"last_ts" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"account_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" numeric(18, 6) NOT NULL,
	"cash" numeric(18, 6) NOT NULL,
	"positions_value" numeric(18, 6) NOT NULL,
	CONSTRAINT "equity_snapshots_account_id_ts_pk" PRIMARY KEY("account_id","ts")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"wallet" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_period" text NOT NULL,
	"category" text NOT NULL,
	"sort_by" text NOT NULL,
	"rank" integer NOT NULL,
	"wallet" text NOT NULL,
	"pnl" numeric(18, 6),
	"volume" double precision
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"slug" text,
	"event_id" text,
	"event_slug" text,
	"image" text,
	"category" text,
	"end_date" timestamp with time zone,
	"closed" boolean DEFAULT false NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"winner_index" integer,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starting_balance" numeric(18, 6) NOT NULL,
	"cash" numeric(18, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"position_id" integer,
	"signal_id" text,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"shares" double precision NOT NULL,
	"avg_price" numeric(10, 6) NOT NULL,
	"notional" numeric(18, 6) NOT NULL,
	"slippage_bps" double precision,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"source_wallet" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome" text,
	"title" text,
	"slug" text,
	"image" text,
	"shares" double precision DEFAULT 0 NOT NULL,
	"avg_price" numeric(10, 6) DEFAULT 0 NOT NULL,
	"cost_basis" numeric(18, 6) DEFAULT 0 NOT NULL,
	"realized_pnl" numeric(18, 6) DEFAULT 0 NOT NULL,
	"current_price" numeric(10, 6),
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leader_ts" timestamp with time zone NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome" text,
	"side" text NOT NULL,
	"leader_price" numeric(10, 6) NOT NULL,
	"leader_size" double precision NOT NULL,
	"leader_usdc" numeric(18, 6) NOT NULL,
	"title" text,
	"slug" text,
	"image" text,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"account_id" integer
);
--> statement-breakpoint
CREATE TABLE "trader_pnl_daily" (
	"wallet" text NOT NULL,
	"day" date NOT NULL,
	"pnl" numeric(18, 6) NOT NULL,
	CONSTRAINT "trader_pnl_daily_wallet_day_pk" PRIMARY KEY("wallet","day")
);
--> statement-breakpoint
CREATE TABLE "trader_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome" text,
	"outcome_index" integer,
	"status" text NOT NULL,
	"avg_price" numeric(18, 6),
	"size" double precision,
	"total_cost" numeric(18, 6),
	"realized_pnl" numeric(18, 6),
	"unrealized_pnl" numeric(18, 6),
	"current_value" numeric(18, 6),
	"title" text,
	"slug" text,
	"event_id" text,
	"category" text,
	"end_date" timestamp with time zone,
	"won" boolean,
	"last_activity_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trader_scores" (
	"wallet" text PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier" text NOT NULL,
	"score" double precision NOT NULL,
	"passed" boolean NOT NULL,
	"n_resolved" integer NOT NULL,
	"n_events" integer NOT NULL,
	"win_rate" double precision,
	"expected_win_rate" double precision,
	"z_skill" double precision,
	"roi" double precision,
	"roi_shrunk" double precision,
	"total_pnl" numeric(18, 6),
	"top_market_share" double precision,
	"top3_share" double precision,
	"profitable_months_pct" double precision,
	"max_drawdown" double precision,
	"sharpe" double precision,
	"copy_adj_roi" double precision,
	"oos_roi" double precision,
	"last_trade_at" timestamp with time zone,
	"primary_category" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trader_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric(10, 6) NOT NULL,
	"size" double precision NOT NULL,
	"usdc_size" numeric(18, 6) NOT NULL,
	"outcome" text,
	"outcome_index" integer,
	"title" text,
	"slug" text,
	"transaction_hash" text
);
--> statement-breakpoint
CREATE TABLE "traders" (
	"wallet" text PRIMARY KEY NOT NULL,
	"name" text,
	"pseudonym" text,
	"profile_image" text,
	"x_username" text,
	"verified_badge" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_backfill_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_position_id_paper_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."paper_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_job_started_at_index" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_captured_at_index" ON "leaderboard_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_wallet_index" ON "leaderboard_snapshots" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "markets_closed_index" ON "markets" USING btree ("closed");--> statement-breakpoint
CREATE INDEX "markets_event_id_index" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "paper_fills_account_id_ts_index" ON "paper_fills" USING btree ("account_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_account_id_token_id_source_wallet_index" ON "paper_positions" USING btree ("account_id","token_id","source_wallet") WHERE "paper_positions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "paper_positions_account_id_status_index" ON "paper_positions" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "signals_detected_at_index" ON "signals" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "signals_wallet_index" ON "signals" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "trader_positions_wallet_token_id_index" ON "trader_positions" USING btree ("wallet","token_id");--> statement-breakpoint
CREATE INDEX "trader_positions_condition_id_index" ON "trader_positions" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "trader_scores_tier_score_index" ON "trader_scores" USING btree ("tier","score");--> statement-breakpoint
CREATE INDEX "trader_trades_wallet_ts_index" ON "trader_trades" USING btree ("wallet","ts");--> statement-breakpoint
CREATE INDEX "trader_trades_condition_id_index" ON "trader_trades" USING btree ("condition_id");