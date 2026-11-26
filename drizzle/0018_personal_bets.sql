CREATE TABLE "custom_bets" (
	"id" serial PRIMARY KEY NOT NULL,
	"portfolio_id" integer NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome_index" integer NOT NULL,
	"outcome" text,
	"title" text,
	"slug" text,
	"event_slug" text,
	"image" text,
	"fee_rate" double precision DEFAULT 0 NOT NULL,
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
ALTER TABLE "custom_bets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"portfolio_id" integer NOT NULL,
	"bet_id" integer NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"shares" double precision NOT NULL,
	"avg_price" numeric(10, 6) NOT NULL,
	"notional" numeric(18, 6) NOT NULL,
	"fee" numeric(18, 6) DEFAULT 0 NOT NULL,
	"realized_pnl" numeric(18, 6),
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_fills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_portfolios" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starting_balance" numeric(18, 6) NOT NULL,
	"cash" numeric(18, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "custom_portfolios" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_snapshots" (
	"portfolio_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" numeric(18, 6) NOT NULL,
	"cash" numeric(18, 6) NOT NULL,
	"positions_value" numeric(18, 6) NOT NULL,
	CONSTRAINT "custom_snapshots_portfolio_id_ts_pk" PRIMARY KEY("portfolio_id","ts")
);
--> statement-breakpoint
ALTER TABLE "custom_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_bets" ADD CONSTRAINT "custom_bets_portfolio_id_custom_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."custom_portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fills" ADD CONSTRAINT "custom_fills_portfolio_id_custom_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."custom_portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fills" ADD CONSTRAINT "custom_fills_bet_id_custom_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."custom_bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_snapshots" ADD CONSTRAINT "custom_snapshots_portfolio_id_custom_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."custom_portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_bets_portfolio_id_status_index" ON "custom_bets" USING btree ("portfolio_id","status");--> statement-breakpoint
CREATE INDEX "custom_fills_portfolio_id_ts_index" ON "custom_fills" USING btree ("portfolio_id","ts");--> statement-breakpoint
CREATE INDEX "custom_fills_bet_id_index" ON "custom_fills" USING btree ("bet_id");