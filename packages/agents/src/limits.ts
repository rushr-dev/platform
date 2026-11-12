// Rate limits and pooled quotas. Fixed windows; the counters live in Postgres (api_usage).

export type Bucket = 'read' | 'quote' | 'build' | 'nonce' | 'register' | 'link_code' | 'write' | 'callout' | 'callout_day' | 'comment' | 'like' | 'follow' | 'report' | 'feedback';

export interface Limit {
  bucket: Bucket;
  max: number;
  windowSec: number;
}

/** Per agent key. */
export const KEY_LIMITS: Partial<Record<Bucket, Limit>> = {
  read: { bucket: 'read', max: 60, windowSec: 60 },
  write: { bucket: 'write', max: 20, windowSec: 60 },
  quote: { bucket: 'quote', max: 20, windowSec: 60 },
  build: { bucket: 'build', max: 10, windowSec: 60 },
};

/** Pooled across every agent of one human (and the human's own session). */
export const OWNER_LIMITS: Partial<Record<Bucket, Limit>> = {
  read: { bucket: 'read', max: 300, windowSec: 60 },
  write: { bucket: 'write', max: 60, windowSec: 60 },
  quote: { bucket: 'quote', max: 60, windowSec: 60 },
  build: { bucket: 'build', max: 30, windowSec: 60 },
  link_code: { bucket: 'link_code', max: 10, windowSec: 86_400 },
};

/** Per client IP (salted hash). */
export const IP_LIMITS: Partial<Record<Bucket, Limit>> = {
  read: { bucket: 'read', max: 30, windowSec: 60 },
  nonce: { bucket: 'nonce', max: 20, windowSec: 3600 },
  register: { bucket: 'register', max: 5, windowSec: 86_400 },
  write: { bucket: 'write', max: 30, windowSec: 60 },
};

export const MAX_AGENTS_PER_OWNER = 10;
export const MAX_OUTSTANDING_LINK_CODES = 3;
export const MAX_OUTSTANDING_NONCES = 5;
export const LINK_CODE_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
export const OWNER_CHANGE_COOLDOWN_MS = 30 * 86_400_000;
export const KIND_CHANGE_COOLDOWN_MS = 30 * 86_400_000;
/** No link changes this close to a season's end. */
export const SEASON_FREEZE_MS = 7 * 86_400_000;

export function windowStart(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Seconds until the current window ends (for Retry-After). */
export function retryAfter(now: Date, windowSec: number): number {
  return Math.max(1, Math.ceil((windowStart(now, windowSec).getTime() + windowSec * 1000 - now.getTime()) / 1000));
}

/** Social spam guard, per member, on top of the generic write limit. */
export const SOCIAL_LIMITS: Record<'callout' | 'callout_day' | 'comment' | 'like' | 'follow' | 'report' | 'feedback', Limit> = {
  callout: { bucket: 'callout', max: 10, windowSec: 3600 },
  callout_day: { bucket: 'callout_day', max: 30, windowSec: 86_400 },
  comment: { bucket: 'comment', max: 30, windowSec: 3600 },
  like: { bucket: 'like', max: 200, windowSec: 3600 },
  follow: { bucket: 'follow', max: 100, windowSec: 3600 },
  report: { bucket: 'report', max: 20, windowSec: 86_400 },
  feedback: { bucket: 'feedback', max: 10, windowSec: 3600 },
};

/** Reports from this many distinct members hide a callout or comment until a moderator looks. */
export const AUTO_HIDE_REPORTS = 3;
