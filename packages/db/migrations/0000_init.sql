CREATE TABLE "balances" (
	"token" text NOT NULL,
	"wallet" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_token_wallet_pk" PRIMARY KEY("token","wallet")
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"token" text NOT NULL,
	"interval" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"volume_usd" numeric NOT NULL,
	"trades" integer NOT NULL,
	CONSTRAINT "candles_token_interval_bucket_pk" PRIMARY KEY("token","interval","bucket")
);
--> statement-breakpoint
CREATE TABLE "deployer_stats" (
	"deployer" text PRIMARY KEY NOT NULL,
	"cluster" text,
	"launches" integer DEFAULT 0 NOT NULL,
	"launches_7d" integer DEFAULT 0 NOT NULL,
	"rugs" integer DEFAULT 0 NOT NULL,
	"migrated" integer DEFAULT 0 NOT NULL,
	"avg_seconds_to_dev_sell" integer,
	"best_peak_mcap_usd" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"quote" text NOT NULL,
	"token_is_currency0" boolean DEFAULT false NOT NULL,
	"dex" text NOT NULL,
	"launchpad" text,
	"hooks" text,
	"created_block" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"token" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"risk_level" text NOT NULL,
	"verdict" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swaps" (
	"tx" text NOT NULL,
	"log_index" integer NOT NULL,
	"token" text NOT NULL,
	"pool" text NOT NULL,
	"block" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"trader" text NOT NULL,
	"side" text NOT NULL,
	"token_amount" numeric(78, 0) NOT NULL,
	"quote" text NOT NULL,
	"quote_amount" numeric(78, 0) NOT NULL,
	"price_usd" numeric,
	"usd" numeric,
	CONSTRAINT "swaps_tx_log_index_pk" PRIMARY KEY("tx","log_index")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"address" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"total_supply" numeric(78, 0) NOT NULL,
	"deployer" text NOT NULL,
	"launchpad" text,
	"created_block" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"tax_bps" integer,
	"quote" text,
	"main_pool" text,
	"price_usd" numeric,
	"ath_market_cap_usd" numeric,
	"image_url" text,
	"website" text,
	"twitter" text,
	"telegram" text,
	"price_eth" numeric,
	"market_cap_usd" numeric,
	"liquidity_usd" numeric,
	"volume_24h_usd" numeric,
	"holders" integer DEFAULT 0 NOT NULL,
	"bonding_progress" numeric,
	"migrated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"tx" text NOT NULL,
	"log_index" integer NOT NULL,
	"token" text NOT NULL,
	"block" bigint NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	CONSTRAINT "transfers_tx_log_index_pk" PRIMARY KEY("tx","log_index")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"first_seen" timestamp with time zone,
	"first_funder" text,
	"funded_at" timestamp with time zone,
	"funding_checked_at" timestamp with time zone,
	"is_contract" boolean,
	"labels" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "balances_wallet_idx" ON "balances" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "pools_token_idx" ON "pools" USING btree ("token");--> statement-breakpoint
CREATE INDEX "swaps_token_time_idx" ON "swaps" USING btree ("token","time");--> statement-breakpoint
CREATE INDEX "swaps_trader_idx" ON "swaps" USING btree ("trader");--> statement-breakpoint
CREATE INDEX "tokens_deployer_idx" ON "tokens" USING btree ("deployer");--> statement-breakpoint
CREATE INDEX "tokens_status_created_idx" ON "tokens" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "transfers_token_idx" ON "transfers" USING btree ("token","block");--> statement-breakpoint
CREATE INDEX "wallets_funder_idx" ON "wallets" USING btree ("first_funder");