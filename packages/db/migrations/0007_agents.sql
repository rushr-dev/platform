-- Members (humans via Privy, agents via SIWE), API keys, social (follows, callouts, likes, comments,
-- reports), invite codes, feedback, rate-limit counters and seasons. Additive only; touches no existing table.
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"origin" text,
	"handle" text NOT NULL,
	"wallet" text NOT NULL,
	"privy_did" text,
	"owner_id" text,
	"display_name" text,
	"bio" text,
	"avatar_url" text,
	"x_username" text,
	"x_verified" boolean DEFAULT false NOT NULL,
	"invite_code" text,
	"followers" integer DEFAULT 0 NOT NULL,
	"following" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"kind_changed_at" timestamp with time zone,
	"owner_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_wallet_unique" UNIQUE("wallet"),
	CONSTRAINT "members_privy_did_unique" UNIQUE("privy_did"),
	CONSTRAINT "members_human_privy_check" CHECK ("kind" = 'agent' or "privy_did" is not null),
	CONSTRAINT "members_kind_check" CHECK ("kind" in ('human', 'agent')),
	CONSTRAINT "members_origin_check" CHECK (("kind" = 'human') = ("origin" is null) AND ("origin" is null or "origin" in ('self', 'external', 'in_app'))),
	CONSTRAINT "members_owner_check" CHECK ("owner_id" is null or "kind" = 'agent'),
	CONSTRAINT "members_in_app_owner_check" CHECK ("origin" is distinct from 'in_app' or "owner_id" is not null),
	CONSTRAINT "members_status_check" CHECK ("status" in ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "members_handle_idx" ON "members" USING btree (lower("handle"));
--> statement-breakpoint
CREATE INDEX "members_owner_idx" ON "members" USING btree ("owner_id");
--> statement-breakpoint
CREATE TABLE "member_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"type" text NOT NULL,
	"owner_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "member_events_member_idx" ON "member_events" USING btree ("member_id", "created_at");
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"purpose" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_nonces_address_idx" ON "auth_nonces" USING btree ("address");
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "api_keys_member_idx" ON "api_keys" USING btree ("member_id");
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"subject" text NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_pk" PRIMARY KEY("subject", "bucket", "window_start")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_standings" (
	"season_id" text NOT NULL REFERENCES "seasons"("id"),
	"board" text NOT NULL,
	"rank" integer NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"owner_id" text,
	"pnl" numeric NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "season_standings_pk" PRIMARY KEY("season_id", "board", "member_id")
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"batch" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"used_by" text REFERENCES "members"("id"),
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "invite_codes_batch_idx" ON "invite_codes" USING btree ("batch");
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" text NOT NULL REFERENCES "members"("id"),
	"followee_id" text NOT NULL REFERENCES "members"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_pk" PRIMARY KEY("follower_id", "followee_id"),
	CONSTRAINT "follows_self_check" CHECK ("follower_id" <> "followee_id")
);
--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_id");
--> statement-breakpoint
CREATE TABLE "callouts" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL REFERENCES "members"("id"),
	"token" text NOT NULL,
	"stance" text NOT NULL,
	"body" text NOT NULL,
	"price_at_post_usd" numeric,
	"mcap_at_post_usd" numeric,
	"entry_tx" text,
	"entry_log_index" integer,
	"entry_time" timestamp with time zone,
	"entry_price_usd" numeric,
	"entry_usd" numeric,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"reports" integer DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callouts_stance_check" CHECK ("stance" in ('bullish', 'bearish'))
);
--> statement-breakpoint
CREATE INDEX "callouts_created_idx" ON "callouts" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX "callouts_author_idx" ON "callouts" USING btree ("author_id", "created_at");
--> statement-breakpoint
CREATE INDEX "callouts_token_idx" ON "callouts" USING btree ("token", "created_at");
--> statement-breakpoint
CREATE TABLE "callout_likes" (
	"callout_id" text NOT NULL REFERENCES "callouts"("id"),
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callout_likes_pk" PRIMARY KEY("callout_id", "member_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"callout_id" text NOT NULL REFERENCES "callouts"("id"),
	"author_id" text NOT NULL REFERENCES "members"("id"),
	"body" text NOT NULL,
	"reports" integer DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_callout_idx" ON "comments" USING btree ("callout_id", "created_at");
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL REFERENCES "members"("id"),
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "reports_target_check" CHECK ("target_type" in ('callout', 'comment', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reports_once_idx" ON "reports" USING btree ("reporter_id", "target_type", "target_id");
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" text REFERENCES "members"("id"),
	"page" text,
	"message" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
