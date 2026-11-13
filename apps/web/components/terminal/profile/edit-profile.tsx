'use client';

import { useRef, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import { patchMe, uploadImage, type ProfileMember } from '@/lib/profile';
import { Modal } from './modal';

const BIO_MAX = 160;
const NAME_MAX = 40;
const https = (v: string) => !v || /^https:\/\/\S+$/i.test(v.trim());

/**
 * Edit display name, one-line bio, avatar and banner. Images upload to the API (/v1/me/avatar|banner)
 * when uploads are enabled; otherwise (feature_disabled) an https image URL works as the fallback.
 */
export function EditProfile({ member, onClose, onSaved }: { member: ProfileMember; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(member.displayName ?? '');
  const [bio, setBio] = useState(member.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(member.avatarUrl ?? '');
  const [bannerUrl, setBannerUrl] = useState(member.bannerUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    if (!https(avatarUrl) || !https(bannerUrl)) return setError('Image links must start with https://');
    setBusy(true);
    setError(null);
    const res = await patchMe({
      displayName: displayName.trim() || null,
      bio: bio.replace(/\s+/g, ' ').trim() || null,
      avatarUrl: avatarUrl.trim() || null,
      bannerUrl: bannerUrl.trim() || null,
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onSaved();
  };

  return (
    <Modal title="Edit profile" onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <ImageField label="Banner" hint="Wide image, up to 3 MB" kind="banner" value={bannerUrl} onChange={setBannerUrl} onNote={setNote} />
        <ImageField label="Avatar" hint="Square image, up to 1 MB" kind="avatar" value={avatarUrl} onChange={setAvatarUrl} onNote={setNote} />
        {note && <p className="text-xs text-muted">{note}</p>}
        <label className="block">
          <span className="flex justify-between text-xs text-muted">
            <span>Display name</span>
            <span>
              {displayName.length}/{NAME_MAX}
            </span>
          </span>
          <input
            value={displayName}
            maxLength={NAME_MAX}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={`@${member.handle}`}
            className="mt-1 w-full rounded-xl border border-white/[0.08] bg-bg px-3 py-2.5 text-sm outline-none focus:border-white/25"
          />
        </label>
        <label className="block">
          <span className="flex justify-between text-xs text-muted">
            <span>Bio (one line)</span>
            <span>
              {bio.length}/{BIO_MAX}
            </span>
          </span>
          <input
            value={bio}
            maxLength={BIO_MAX}
            onChange={(e) => setBio(e.target.value.replace(/[\r\n]+/g, ' '))}
            placeholder="What do you trade?"
            className="mt-1 w-full rounded-xl border border-white/[0.08] bg-bg px-3 py-2.5 text-sm outline-none focus:border-white/25"
          />
        </label>
        {error && <p role="alert" className="text-xs text-risk-high">{error}</p>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/[0.08] py-2.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg hover:bg-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImageField({
  label,
  hint,
  kind,
  value,
  onChange,
  onNote,
}: {
  label: string;
  hint: string;
  kind: 'avatar' | 'banner';
  value: string;
  onChange: (v: string) => void;
  onNote: (n: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <div>
      <span className="text-xs text-muted">
        {label} <span className="text-muted/70">· {hint}</span>
      </span>
      <div className="mt-1 flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="https://…"
          className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-bg px-3 py-2 text-sm outline-none focus:border-white/25"
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => input.current?.click()}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/[0.08] px-3 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
        >
          <UploadSimple size={14} /> {uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setUploading(true);
            onNote(null);
            const res = await uploadImage(kind, file);
            setUploading(false);
            if (res.ok) onChange(res.url);
            else onNote(res.message);
          }}
        />
      </div>
    </div>
  );
}
