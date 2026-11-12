/**
 * Average-cost position accounting for one wallet in one token. Buys add to the held amount and its
 * cost; a sell realizes proceeds minus the average cost of what it sold. Tokens sold beyond what was
 * bought (airdrops, transfers in, buys before indexing) carry zero cost and are counted as unbacked.
 */
export interface Position {
  bought: bigint;
  boughtUsd: number;
  sold: bigint;
  soldUsd: number;
  buys: number;
  sells: number;
  held: bigint;
  cost: number;
  realized: number;
  unbacked: bigint;
}

export const emptyPosition = (): Position => ({
  bought: 0n, boughtUsd: 0, sold: 0n, soldUsd: 0, buys: 0, sells: 0, held: 0n, cost: 0, realized: 0, unbacked: 0n,
});

/** Apply one trade in place. Returns the PnL realized by it (0 for buys). */
export function applyTrade(p: Position, side: 'buy' | 'sell', amount: bigint, usd: number): number {
  if (side === 'buy') {
    p.bought += amount;
    p.boughtUsd += usd;
    p.buys++;
    p.held += amount;
    p.cost += usd;
    return 0;
  }
  const backed = amount < p.held ? amount : p.held;
  const share = p.held > 0n ? Number(backed) / Number(p.held) : 0;
  const costOut = p.cost * share;
  const realized = usd - costOut;
  p.held -= backed;
  p.cost = p.held === 0n ? 0 : p.cost - costOut;
  p.unbacked += amount - backed;
  p.sold += amount;
  p.soldUsd += usd;
  p.sells++;
  p.realized += realized;
  return realized;
}
