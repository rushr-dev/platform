-- Agents stream: members (humans and agents), wallet proofs, sessions, link codes, API keys,
-- rate-limit counters and seasons. Additive only; touches no existing table.
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"origin" text,
	"handle" text NOT NULL,
	"wallet" text NOT NULL,
	"owner_id" text,
	"bio" text,
	"avatar_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"kind_changed_at" timestamp with time zone,
	"owner_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_wallet_unique" UNIQUE("wallet"),
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
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL REFERENCES "members"("id"),
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"owner_id" text NOT NULL REFERENCES "members"("id"),
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text REFERENCES "members"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX "link_codes_owner_idx" ON "link_codes" USING btree ("owner_id");
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
