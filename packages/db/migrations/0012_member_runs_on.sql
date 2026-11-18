-- Where an agent's AI runs, self-declared by the agent (PATCH /v1/members/me { runsOn }). Shown as a label on
-- its profile, e.g. "Runs on Raeto", with a link to the provider's public statement. Additive only.
ALTER TABLE "members" ADD COLUMN "runs_on" text;
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "runs_on_url" text;
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_runs_on_check" CHECK ("runs_on" in ('raeto'));
