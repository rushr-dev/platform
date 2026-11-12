'use client';

import { useMemo, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force';
import { pct, short } from '@/lib/format';

export interface BubbleData {
  nodes: { wallet: string; pct: number; tags: string[]; funder: string | null }[];
  edges: { a: string; b: string; kind: 'shared-funder' | 'funded' | 'transfer' }[];
  clusters: { funder: string; wallets: string[]; pct: number }[];
}

type Node = SimulationNodeDatum & BubbleData['nodes'][number] & { r: number; cluster: number };

const W = 720;
const H = 420;
const CLUSTER_COLORS = ['#ff6b5b', '#ffb547', '#b58cff', '#5ec8ff', '#ff7ab6', '#4de0c2'];

/** Top holders as bubbles sized by share; linked when they share a funder, funded each other or traded tokens. */
export function BubbleMap({ data }: { data: BubbleData }) {
  const [hover, setHover] = useState<Node | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const { nodes, links } = useMemo(() => {
    const clusterOf = new Map<string, number>();
    data.clusters.forEach((c, i) => c.wallets.forEach((w) => clusterOf.set(w, i)));
    const nodes: Node[] = data.nodes.map((n) => ({
      ...n,
      r: Math.max(5, Math.sqrt(Math.max(n.pct, 0.05)) * 11),
      cluster: clusterOf.get(n.wallet) ?? -1,
    }));
    const ids = new Set(nodes.map((n) => n.wallet));
    const links = data.edges.filter((e) => ids.has(e.a) && ids.has(e.b)).map((e) => ({ source: e.a, target: e.b, kind: e.kind }));
    // Run the layout up front: a static picture, no animation work on the main thread after mount.
    const sim = forceSimulation(nodes)
      .force('link', forceLink<Node, { source: string; target: string }>(links).id((d) => d.wallet).distance(30).strength(0.6))
      .force('charge', forceManyBody().strength(-28))
      .force('collide', forceCollide<Node>((d) => d.r + 2))
      .force('center', forceCenter(W / 2, H / 2))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    for (const n of nodes) {
      n.x = Math.max(n.r, Math.min(W - n.r, n.x ?? 0));
      n.y = Math.max(n.r, Math.min(H - n.r, n.y ?? 0));
    }
    return { nodes, links: links as unknown as { source: Node; target: Node; kind: string }[] };
  }, [data]);

  // Hovering a cluster (or one of its bubbles) dims everything else.
  const active = focus ?? (hover && hover.cluster >= 0 ? hover.cluster : null);
  const dim = (n: Node) => active != null && n.cluster !== active;
  const color = (n: Node) =>
    n.cluster >= 0 ? CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length]! : n.tags.includes('dev') ? '#ffffff' : '#36d42a';

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_240px]">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          {links.map((l, i) => (
            <line
              key={i}
              x1={l.source.x}
              y1={l.source.y}
              x2={l.target.x}
              y2={l.target.y}
              stroke={l.kind === 'transfer' ? 'rgba(94,200,255,0.4)' : 'rgba(255,255,255,0.18)'}
              strokeDasharray={l.kind === 'transfer' ? '3 3' : undefined}
              opacity={active != null && (l.source.cluster !== active || l.target.cluster !== active) ? 0.15 : 1}
            />
          ))}
          {nodes.map((n) => (
            <circle
              key={n.wallet}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={color(n)}
              fillOpacity={hover?.wallet === n.wallet ? 0.55 : dim(n) ? 0.05 : 0.22}
              stroke={color(n)}
              strokeOpacity={dim(n) ? 0.25 : 1}
              strokeWidth={n.tags.includes('dev') ? 2.4 : 1.2}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
              onClick={() => window.open(`https://robinhoodchain.blockscout.com/address/${n.wallet}`, '_blank', 'noopener')}
              className="cursor-pointer transition-[fill-opacity,stroke-opacity] duration-150"
            >
              <title>{`${n.wallet} · ${pct(n.pct, 2)}`}</title>
            </circle>
          ))}
        </svg>
        {hover && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-xl border border-white/10 bg-surface-2 px-3 py-2 text-xs shadow-xl">
            <div className="font-mono">{short(hover.wallet)}</div>
            <div className="mt-0.5 text-muted">
              holds <span className="text-ink">{pct(hover.pct, 2)}</span>
              {hover.tags.length ? ` · ${hover.tags.join(', ')}` : ''}
            </div>
            {hover.funder && <div className="mt-0.5 text-muted">funded by {short(hover.funder)}</div>}
          </div>
        )}
      </div>
      <div className="space-y-2 text-xs">
        <div className="font-semibold">Clusters</div>
        {data.clusters.length === 0 && <p className="text-muted">No linked wallets among the top holders.</p>}
        {data.clusters.slice(0, 6).map((c, i) => (
          <div
            key={c.funder}
            onMouseEnter={() => setFocus(i)}
            onMouseLeave={() => setFocus(null)}
            className={`flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${focus === i ? 'bg-white/[0.08]' : 'bg-white/[0.03]'}`}
          >
            <span className="size-2.5 rounded-full" style={{ background: CLUSTER_COLORS[i % CLUSTER_COLORS.length] }} />
            <span className="flex-1">
              {c.wallets.length} wallets, one funder
              <span className="block font-mono text-[10px] text-muted">{short(c.funder)}</span>
            </span>
            <span className={`font-mono ${c.pct >= 10 ? 'text-risk-high' : ''}`}>{pct(c.pct)}</span>
          </div>
        ))}
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full border border-white bg-white/20" /> Dev
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-brand/60" /> Unlinked
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-risk-high/70" /> Cluster
          </span>
        </div>
        <p className="leading-relaxed text-muted">
          Bubble size is share of supply. Lines join wallets that share a funder or funded each other; dashed blue lines are token transfers between them. Click a bubble to open the wallet.
        </p>
      </div>
    </div>
  );
}
