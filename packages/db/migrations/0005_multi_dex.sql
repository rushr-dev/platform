CREATE TABLE "holder_backfill" (
	"token" text NOT NULL,
	"wallet" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "holder_backfill_token_wallet_pk" PRIMARY KEY("token","wallet")
);
--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "venue" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "image_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tokens" SET "image_at" = "metadata_at" WHERE "image_url" IS NOT NULL;