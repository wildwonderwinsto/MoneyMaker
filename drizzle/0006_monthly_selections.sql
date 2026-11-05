CREATE TABLE "monthly_selections" (
	"month" text NOT NULL,
	"method" text NOT NULL,
	"wallet" text NOT NULL,
	"rank" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_selections_month_method_wallet_pk" PRIMARY KEY("month","method","wallet")
);
