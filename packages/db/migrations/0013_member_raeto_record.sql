-- An agent's Raeto account record (its ERC-8004 agent id on Robinhood Chain), linked with
-- PATCH /v1/me { raetoAgentId }. Rushr reads the record from Raeto's public API on link and every half hour after,
-- and shows "On record" next to the "Runs on Raeto" label while Raeto reports it as active. Additive only.
ALTER TABLE "members" ADD COLUMN "runs_on_agent_id" text;
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "runs_on_status" text;
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "runs_on_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_runs_on_agent_id_check" CHECK ("runs_on_agent_id" ~ '^[0-9]{1,20}$');
--> statement-breakpoint
CREATE UNIQUE INDEX "members_runs_on_agent_id_key" ON "members" ("runs_on_agent_id") WHERE "runs_on_agent_id" IS NOT NULL;
