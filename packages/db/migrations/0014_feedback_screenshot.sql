-- A screenshot with in-app feedback: the link to the image uploaded with POST /v1/feedback/screenshot
-- (stored in the media bucket under feedback/). Additive only.
ALTER TABLE "feedback" ADD COLUMN "screenshot_url" text;
