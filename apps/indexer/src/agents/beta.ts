// Beta wrapper: feedback from anyone (signed in or not).
import { Hono } from 'hono';
import { SOCIAL_LIMITS } from '@rushr/agents/limits';
import { on } from './env';
import { randomId } from '@rushr/agents/crypto';
import { fail, limit, PRIVATE, publicCache, str, type Ctx } from './http';
import { sniffImage } from './media';

/** Screenshots with feedback: at most 3MB, PNG/JPEG/WebP/GIF only (sniffed from the bytes). */
const SCREENSHOT_MAX = 3_000_000;
const SCREENSHOT_PATH = '/v1/media/feedback/';

export const beta = new Hono<Ctx>();

/**
 * A screenshot to attach to feedback: the raw image as the body. Anyone may send one (feedback is open to
 * signed-out visitors too), rate-limited like other uploads. Answers `{ url }` to pass as `screenshotUrl`.
 */
beta.post('/feedback/screenshot', async (c) => {
  if (!on(c.env.MEDIA_UPLOADS_ENABLED) || !c.env.MEDIA) throw fail(404, 'feature_disabled', 'Screenshot uploads are not enabled.');
  if (Number(c.req.header('content-length') ?? 0) > SCREENSHOT_MAX) throw fail(413, 'too_large', 'Screenshots are at most 3MB.');
  await limit(c, 'write', [SOCIAL_LIMITS.upload]);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) throw fail(422, 'invalid_image', 'Send the image bytes as the request body.');
  if (bytes.length > SCREENSHOT_MAX) throw fail(413, 'too_large', 'Screenshots are at most 3MB.');
  const img = sniffImage(bytes);
  if (!img) throw fail(415, 'unsupported_image', 'Use PNG, JPEG, WebP or GIF.');
  const file = `${randomId(16)}.${img.ext}`;
  await c.env.MEDIA.put(`feedback/${file}`, bytes, { httpMetadata: { contentType: img.type, cacheControl: 'public, max-age=31536000, immutable' } });
  return c.json({ url: `${new URL(c.req.url).origin}${SCREENSHOT_PATH}${file}` }, 201, PRIVATE);
});

/** `{ message (1-2000), page?, screenshotUrl? }`. Stores the member when signed in. */
beta.post('/feedback', async (c) => {
  await limit(c, 'write', [SOCIAL_LIMITS.feedback]);
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const message = str(b.message, 2000, 'message', { required: true })!;
  const page = str(b.page, 300, 'page');
  const ua = (c.req.header('user-agent') ?? '').slice(0, 300) || null;
  // Only a screenshot uploaded here (POST /feedback/screenshot): never an arbitrary link.
  const shot = str(b.screenshotUrl, 300, 'screenshotUrl');
  const prefix = `${new URL(c.req.url).origin}${SCREENSHOT_PATH}`;
  if (shot && !(shot.startsWith(prefix) && /^[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(shot.slice(prefix.length))))
    throw fail(422, 'invalid_field', 'screenshotUrl must come from POST /v1/feedback/screenshot.', { field: 'screenshotUrl' });
  const [row] = await c.var.sql<{ id: string }[]>`
    insert into feedback (member_id, page, message, user_agent, screenshot_url) values (${c.var.viewer.member?.id ?? null}, ${page}, ${message}, ${ua}, ${shot ?? null}) returning id::text`;
  return c.json({ received: true, id: row!.id }, 201, PRIVATE);
});

/**
 * Public seat counter for the beta drop, from the code marked `public` (never the code itself).
 * `open` = sign-up through that code works right now.
 */
beta.get('/beta', async (c) => {
  const [row] = await c.var.sql<{ max_uses: number; uses: number; revoked_at: Date | null; expires_at: Date | null }[]>`
    select max_uses, uses, revoked_at, expires_at from invite_codes where public limit 1`;
  const invitesRequired = on(c.env.INVITES_REQUIRED);
  if (!row) return c.json({ open: false, seats: 0, taken: 0, left: 0, invitesRequired }, 200, publicCache(10));
  const live = !row.revoked_at && (!row.expires_at || row.expires_at.getTime() > Date.now());
  const left = live ? Math.max(row.max_uses - row.uses, 0) : 0;
  return c.json({ open: left > 0, seats: row.max_uses, taken: row.uses, left, invitesRequired }, 200, publicCache(10));
});
