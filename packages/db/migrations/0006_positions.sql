CREATE TABLE "positions" (
	"wallet" text NOT NULL,
	"token" text NOT NULL,
	"bought_tokens" numeric(78, 0) DEFAULT '0' NOT NULL,
	"bought_usd" numeric DEFAULT '0' NOT NULL,
	"sold_tokens" numeric(78, 0) DEFAULT '0' NOT NULL,
	"sold_usd" numeric DEFAULT '0' NOT NULL,
	"buys" integer DEFAULT 0 NOT NULL,
	"sells" integer DEFAULT 0 NOT NULL,
	"held_tokens" numeric(78, 0) DEFAULT '0' NOT NULL,
	"cost_basis_usd" numeric DEFAULT '0' NOT NULL,
	"realized_usd" numeric DEFAULT '0' NOT NULL,
	"unbacked_sold_tokens" numeric(78, 0) DEFAULT '0' NOT NULL,
	"first_trade_at" timestamp with time zone NOT NULL,
	"last_trade_at" timestamp with time zone NOT NULL,
	CONSTRAINT "positions_wallet_token_pk" PRIMARY KEY("wallet","token")
);
--> statement-breakpoint
CREATE TABLE "wallet_pnl" (
	"wallet" text PRIMARY KEY NOT NULL,
	"realized_usd" numeric NOT NULL,
	"unrealized_usd" numeric NOT NULL,
	"realized_24h_usd" numeric NOT NULL,
	"realized_7d_usd" numeric NOT NULL,
	"realized_30d_usd" numeric NOT NULL,
	"volume_usd" numeric NOT NULL,
	"trades" integer NOT NULL,
	"tokens_traded" integer NOT NULL,
	"win_rate" numeric,
	"best_trade_usd" numeric,
	"last_trade_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "realized_usd" numeric;--> statement-breakpoint
CREATE INDEX "positions_token_idx" ON "positions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "wallet_pnl_realized_idx" ON "wallet_pnl" USING btree ("realized_usd");--> statement-breakpoint
CREATE INDEX "swaps_trader_time_idx" ON "swaps" USING btree ("trader","time");--> statement-breakpoint
DROP INDEX "swaps_trader_idx";