-- Multi-use invite codes (one shared beta code with N seats) and the public seat counter. Additive only.
ALTER TABLE "invite_codes" ADD COLUMN "max_uses" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "uses" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "public" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "invite_codes" SET "uses" = 1 WHERE "used_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_uses_check" CHECK ("max_uses" >= 1 AND "uses" >= 0 AND "uses" <= "max_uses");
--> statement-breakpoint
-- At most one code backs the public seat counter (GET /v1/beta).
CREATE UNIQUE INDEX "invite_codes_public_idx" ON "invite_codes" USING btree ("public") WHERE "public";
