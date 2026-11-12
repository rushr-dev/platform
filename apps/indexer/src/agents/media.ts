// Avatar and banner uploads to R2 (behind MEDIA_UPLOADS_ENABLED and the MEDIA binding). Raw image bytes
// in the body; the type is sniffed from the bytes, never trusted from the client. No SVG (scriptable).
import { Hono } from 'hono';
import { randomId } from '@rushr/agents/crypto';
import { SOCIAL_LIMITS } from '@rushr/agents/limits';
import { on } from './env';
import { fail, limit, memberColumns, PRIVATE, requireMember, type C, type Ctx, type MemberRow } from './http';
import { publicMember } from './members';

const KINDS = {
  avatar: { maxBytes: 1_000_000, column: 'avatar_url' },
  banner: { maxBytes: 3_000_000, column: 'banner_url' },
} as const;
type Kind = keyof typeof KINDS;

/** Sniff PNG, JPEG, WebP or GIF from magic bytes. */
export function sniffImage(b: Uint8Array): { type: string; ext: string } | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', ext: 'png' };
  if (at(0, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', ext: 'jpg' };
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { type: 'image/webp', ext: 'webp' };
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return { type: 'image/gif', ext: 'gif' };
  return null;
}

function bucket(c: C): R2Bucket {
  if (!on(c.env.MEDIA_UPLOADS_ENABLED) || !c.env.MEDIA) throw fail(404, 'feature_disabled', 'Image uploads are not enabled yet. Set an https image URL instead (PATCH /v1/me).');
  return c.env.MEDIA;
}

async function upload(c: C, kind: Kind) {
  const m = requireMember(c, { scope: 'profile' });
  const r2 = bucket(c);
  const { maxBytes, column } = KINDS[kind];
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > maxBytes) throw fail(413, 'too_large', `${kind} images are at most ${maxBytes / 1_000_000}MB.`);
  await limit(c, 'write', [SOCIAL_LIMITS.upload]);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) throw fail(422, 'invalid_image', 'Send the image bytes as the request body.');
  if (bytes.length > maxBytes) throw fail(413, 'too_large', `${kind} images are at most ${maxBytes / 1_000_000}MB.`);
  const img = sniffImage(bytes);
  if (!img) throw fail(415, 'unsupported_image', 'Use PNG, JPEG, WebP or GIF.');

  const key = `${kind}/${m.id}/${randomId(12)}.${img.ext}`;
  await r2.put(key, bytes, { httpMetadata: { contentType: img.type, cacheControl: 'public, max-age=31536000, immutable' } });
  const url = `${new URL(c.req.url).origin}/v1/media/${key}`;
  const sql = c.var.sql;
  const old = await sql<{ key: string }[]>`select key from media where member_id = ${m.id} and kind = ${kind} and deleted_at is null`;
  const [row] = await sql.begin(async (tx) => {
    await tx`update media set deleted_at = now() where member_id = ${m.id} and kind = ${kind} and deleted_at is null`;
    await tx`insert into media (key, member_id, kind, content_type, bytes) values (${key}, ${m.id}, ${kind}, ${img.type}, ${bytes.length})`;
    return tx.unsafe<MemberRow[]>(`update members set ${column} = $2, updated_at = now() where id = $1 returning ${memberColumns}`, [m.id, url]);
  });
  if (old.length) await r2.delete(old.map((o) => o.key)).catch(() => {});
  return c.json({ url, member: publicMember(row!) }, 201, PRIVATE);
}

export const media = new Hono<Ctx>();

/** Raw image body (PNG, JPEG, WebP, GIF; avatar ≤1MB, banner ≤3MB). Replaces the previous upload. */
media.post('/me/avatar', (c) => upload(c, 'avatar'));
media.post('/me/banner', (c) => upload(c, 'banner'));

media.get('/media/:kind{avatar|banner}/:member/:file', async (c) => {
  const r2 = bucket(c);
  const key = `${c.req.param('kind')}/${c.req.param('member')}/${c.req.param('file')}`;
  const obj = await r2.get(key);
  if (!obj) throw fail(404, 'not_found', 'No such image.');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
});
