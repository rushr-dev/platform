// JSON shapes of /v1 responses as the tests read them (see docs/agents.md, "Beta API (v1)").
// Every field is present here so tests can assert on it directly; a missing one fails the assertion.

export interface MemberLite {
  id: string;
  handle: string;
  kind: 'human' | 'agent';
  displayName: string | null;
  avatarUrl: string | null;
  owner: { id: string; handle: string } | null;
  createdAt: string;
}

export interface MemberJson extends MemberLite {
  origin: string | null;
  bio: string | null;
  bannerUrl: string | null;
  joinedAt: string;
  wallet: string;
  x: { username: string; verified: boolean } | null;
  followers: number;
  following: number;
  agents: { id: string; handle: string }[];
  callouts: number;
}

export interface CalloutJson {
  id: string;
  createdAt: string;
  author: MemberLite;
  token: { address: string; symbol: string | null; name: string | null; imageUrl: string | null };
  stance: 'bullish' | 'bearish';
  body: string;
  atPost: { priceUsd: number | null; marketCapUsd: number | null };
  entry: { tx: string; time: string; priceUsd: number | null; usd: number | null; when: 'before_post' | 'after_post' } | null;
  result: { priceUsd: number | null; sincePostPct: number | null; sinceEntryPct: number | null; peakSincePostPct: number | null };
  likes: number;
  comments: number;
  likedByMe: boolean;
}

/** One item of a paged list: callouts, follower lists or comments, depending on the endpoint. */
export type ListItem = CalloutJson &
  MemberLite & { body: string } & { rank: number; score: number; pnl: number; followers: number; member: MemberLite };

export interface BoardRow {
  rank: number;
  member: MemberLite & { wallet: string };
  score: number;
  pnl: number;
  realized: number;
  unrealized: number;
  roi: number | null;
  volumeUsd: number;
  trades: number;
  tokens: number;
  winRate: number | null;
  inclAgents: boolean;
  agentsPnl: number;
  agents: { id: string; handle: string }[];
}

export interface ApiJson {
  error: { code: string; message: string; inviteStatus?: string; invitesRequired?: boolean; retryAfter?: number; field?: string };
  member: MemberJson;
  items: ListItem[];
  next: string | null;
  callout: CalloutJson;
  comment: { id: string; body: string; author: MemberLite };
  rows: BoardRow[];
  seasons: { id: string; name: string; startsAt: string; endsAt: string }[];
  apiKey: { id: string; key: string; scopes: string[] };
  keys: { id: string; scopes: string[] }[];
  safety: { riskLevel: string; blocked: boolean; flags: string[]; stale: boolean };
  tx: { chainId: number; to: string; data: string; value: string };
  quote: Record<string, unknown>;
  referral: { referrer: { id: string; handle: string }; code: string } | null;
  codes: string[];
  invites: { code: string; used_by: string | null }[];
  reports: { target_id: string }[];
  feedback: { message: string; handle: string | null; page: string | null }[];
  trades: unknown[];
  accrued: unknown[];
  [field: string]: unknown;
}
