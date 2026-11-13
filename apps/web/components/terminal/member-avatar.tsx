'use client';

import { useState } from 'react';
import { GeneratedAvatar } from './avatar';
import { iconSrc } from './bits';

/**
 * One avatar for a member everywhere (top bar, menus, profiles, calls, comments, chart markers):
 * their uploaded image when they have one, else a generated avatar seeded by the stable member id
 * with the handle's initial. Before someone registers there is no member id yet, so the wallet
 * address seeds it until they do.
 */

export interface AvatarMember {
  id: string;
  handle: string;
  avatarUrl?: string | null;
}

/** 40 hex chars from any string (FNV-1a, chained), so a member id can seed the generated avatar. */
export function seedHex(input: string): string {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= round;
    h = Math.imul(h, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

/** The seed for a member (by id) or, before registration, a wallet. */
export function avatarSeed(member: Pick<AvatarMember, 'id'> | null | undefined, wallet?: string | null): string {
  if (member) return seedHex(member.id);
  if (wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)) return wallet.toLowerCase();
  return seedHex(wallet ?? 'anonymous');
}

export function MemberAvatar({
  member,
  wallet = null,
  label,
  size,
  className = '',
}: {
  member?: AvatarMember | null;
  /** Seeds the avatar when there is no member yet. */
  wallet?: string | null;
  /** Initial source when there is no member (e.g. the sign-in name). */
  label?: string;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = member?.avatarUrl || null;
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-full ${className}`} style={{ width: size, height: size }}>
      <GeneratedAvatar address={avatarSeed(member, wallet)} symbol={member?.handle ?? label ?? ''} size={size} />
      {url && failed !== url && (
        <img src={iconSrc(url)} alt="" width={size} height={size} onError={() => setFailed(url)} className="absolute inset-0 size-full object-cover" />
      )}
    </span>
  );
}
