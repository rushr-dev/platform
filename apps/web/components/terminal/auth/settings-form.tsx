'use client';

import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { DEFAULT_SETTINGS, LIMITS, sanitize, updateSettings, useSettings, type TradeSettings } from '@/lib/settings';

/** Buy/sell presets, the trenches quick-buy amount, slippage and the per-trade cap. */
export function SettingsForm() {
  const saved = useSettings();
  const [draft, setDraft] = useState<TradeSettings>(saved);
  // Typed as text so "0." and "1.5" can be entered; parsed on save.
  const [slip, setSlip] = useState(String(saved.slippagePct)); // 'auto' or a number as text
  const [cap, setCap] = useState(String(saved.maxTradeEth));
  const [sells, setSells] = useState(saved.sellPresets.map(String));
  const [done, setDone] = useState(false);
  // Pick up the stored values once they're read on the client.
  useEffect(() => {
    setDraft(saved);
    setSlip(String(saved.slippagePct));
    setCap(String(saved.maxTradeEth));
    setSells(saved.sellPresets.map(String));
  }, [saved]);
  const slipValue: TradeSettings['slippagePct'] = slip === 'auto' || slip === '' ? 'auto' : Number(slip);

  const clean = sanitize({ ...draft, slippagePct: slipValue, maxTradeEth: Number(cap), sellPresets: sells.map(Number) as TradeSettings['sellPresets'] });
  const dirty = JSON.stringify(clean) !== JSON.stringify(saved);
  const capWarn = Number(clean.quickBuy) > clean.maxTradeEth || clean.buyPresets.some((p) => Number(p) > clean.maxTradeEth);

  const save = () => {
    updateSettings(clean);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };

  return (
    <form
      className="mt-6 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Section title="Buy presets" hint="ETH amounts on the token page's one-tap buy buttons.">
        <div className="grid grid-cols-4 gap-2">
          {draft.buyPresets.map((v, i) => (
            <Field
              key={i}
              value={v}
              suffix="ETH"
              onChange={(x) => setDraft({ ...draft, buyPresets: draft.buyPresets.map((p, j) => (j === i ? x : p)) as TradeSettings['buyPresets'] })}
            />
          ))}
        </div>
      </Section>

      <Section title="Sell presets" hint="Percent of your position.">
        <div className="grid grid-cols-3 gap-2">
          {sells.map((v, i) => (
            <Field key={i} value={v} suffix="%" onChange={(x) => setSells(sells.map((p, j) => (j === i ? x : p)))} />
          ))}
        </div>
      </Section>

      <Section title="Trenches quick buy" hint="What one tap on a trenches row buys.">
        <div className="grid grid-cols-4 gap-2">
          <Field value={draft.quickBuy} suffix="ETH" onChange={(x) => setDraft({ ...draft, quickBuy: x })} />
        </div>
      </Section>

      <Section
        title="Slippage"
        hint={`How far the price may move before a trade fails. Auto picks 5–15% from the token's age, volatility and price impact, plus its tax. Or fix it (${LIMITS.slippagePct[0]}–${LIMITS.slippagePct[1]}%).`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSlip('auto')}
            className={`rounded-xl border px-3 py-2 text-sm ${slipValue === 'auto' ? 'border-white/25 text-ink' : 'border-white/[0.06] text-muted hover:text-ink'}`}
          >
            Auto
          </button>
          {[1, 5, 10, 20].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setSlip(String(v))}
              className={`rounded-xl border px-3 py-2 font-mono text-sm ${Number(slip) === v ? 'border-white/25 text-ink' : 'border-white/[0.06] text-muted hover:text-ink'}`}
            >
              {v}%
            </button>
          ))}
          <div className="w-28">
            <Field value={slip === 'auto' ? '' : slip} suffix="%" onChange={(x) => setSlip(x || 'auto')} />
          </div>
        </div>
      </Section>

      <Section title="Per-trade cap" hint={`No single buy above this goes out, whatever the button says (${LIMITS.maxTradeEth[0]}–${LIMITS.maxTradeEth[1]} ETH).`}>
        <div className="w-40">
          <Field value={cap} suffix="ETH" onChange={setCap} />
        </div>
        {capWarn && <p className="mt-2 text-xs text-risk-medium">Some presets are above your cap; those buttons will be refused.</p>}
      </Section>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={!dirty} className="flex items-center gap-1.5 rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-bg hover:bg-white disabled:opacity-40">
          {done ? (
            <>
              <Check size={15} /> Saved
            </>
          ) : (
            'Save'
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(DEFAULT_SETTINGS);
            setSlip(String(DEFAULT_SETTINGS.slippagePct));
            setCap(String(DEFAULT_SETTINGS.maxTradeEth));
            setSells(DEFAULT_SETTINGS.sellPresets.map(String));
          }}
          className="text-sm text-muted hover:text-ink"
        >
          Reset to defaults
        </button>
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mb-3 mt-0.5 text-xs text-muted">{hint}</p>
      {children}
    </section>
  );
}

function Field({ value, suffix, onChange }: { value: string; suffix: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center rounded-xl border border-white/[0.06] bg-bg px-3 py-2 focus-within:border-white/20">
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, '').slice(0, 10))}
        className="w-full min-w-0 bg-transparent font-mono text-sm outline-none"
      />
      <span className="ml-1 font-mono text-[11px] text-muted">{suffix}</span>
    </label>
  );
}
