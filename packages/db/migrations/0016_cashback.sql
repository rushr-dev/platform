-- Cashback (decided 2026-11-25): 30% of the platform fee a trader actually paid goes back to them, accrued per
-- confirmed trade in the ledger (apps/indexer/src/ledger.ts) and paid weekly from the treasury Safe
-- (packages/trade/scripts/cashback-batch.ts). Additive only.
ALTER TABLE "trades_ledger" ADD COLUMN IF NOT EXISTS "cashback_share_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trades_ledger" ADD COLUMN IF NOT EXISTS "cashback_accrual" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- One row per wallet, fee token and weekly batch. 'pending' once the batch is built for the Safe, 'paid' once its
-- transaction is confirmed on-chain, 'void' when a batch is dropped (its amounts are owed again).
CREATE TABLE IF NOT EXISTS "cashback_payouts" (
  "id" text PRIMARY KEY NOT NULL,
  "batch" text NOT NULL,
  "wallet" text NOT NULL,
  "fee_token" text NOT NULL,
  "amount" numeric(78, 0) NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "tx_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone,
  CONSTRAINT "cashback_payouts_status_check" CHECK ("status" in ('pending', 'paid', 'void')),
  CONSTRAINT "cashback_payouts_amount_check" CHECK ("amount" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashback_payouts_batch_wallet_idx" ON "cashback_payouts" ("batch", "wallet", "fee_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cashback_payouts_wallet_idx" ON "cashback_payouts" ("wallet");
