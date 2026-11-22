-- FOMO activity on Robinhood Chain, read from fomoapi.io's alert feed (apps/indexer/src/fomo.ts):
-- theses (a FOMO trader's written reason for a trade) and FOMO's large buys and sells. Shown as markers
-- on the token chart. Additive only.
CREATE TABLE IF NOT EXISTS "fomo_events" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "token" text NOT NULL,
  "handle" text NOT NULL,
  "user_id" text,
  "avatar_url" text,
  "body" text,
  "usd" numeric,
  "ts" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "fomo_events_token_ts_idx" ON "fomo_events" ("token", "ts" DESC);
