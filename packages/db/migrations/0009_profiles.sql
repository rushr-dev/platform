-- Profiles: banner image, and uploaded media (avatars, banners) stored in R2. Additive only.
ALTER TABLE "members" ADD COLUMN "banner_url" text;
--> statement-breakpoint
CREATE TABLE "media" (
	"key" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_kind_check" CHECK ("kind" in ('avatar', 'banner'))
);
--> statement-breakpoint
CREATE INDEX "media_member_idx" ON "media" USING btree ("member_id", "created_at");
