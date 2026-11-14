#!/usr/bin/env bash
# The indexer's off switch: stop (and restart) everything that spends RPC, without a code push.
#
#   scripts/indexer-switch.sh off [reason]   pause the indexer and queue delivery
#   scripts/indexer-switch.sh on             resume queue delivery and the indexer (catches up from its cursor)
#   scripts/indexer-switch.sh status         show the pause flag, the cursor and the poller
#
# While off, the site stays browsable on the last indexed data, and trade quotes, builds and ledger
# submits keep working. See apps/indexer/src/pause.ts for exactly what stops.
#
# Needs ADMIN_TOKEN in apps/indexer/.dev.vars.prod (never printed) and a logged-in wrangler.
# INDEXER_URL overrides the target (default https://api.rushr.trade).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEXER="$ROOT/apps/indexer"
URL="${INDEXER_URL:-https://api.rushr.trade}"
QUEUES=(rushr-enrich rushr-metadata)
ACTION="${1:-status}"
REASON="${2:-}"

token() {
  local f="$INDEXER/.dev.vars.prod"
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
  local t
  t="$(grep -E '^ADMIN_TOKEN=' "$f" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  [[ -n "$t" ]] || { echo "ADMIN_TOKEN not set in $f" >&2; exit 1; }
  printf '%s' "$t"
}

# The token goes to curl on stdin (-H @-), so it never shows in the process list or the terminal.
admin() {
  local method="$1" path="$2"
  printf 'Authorization: Bearer %s\n' "$(token)" | curl -sS --fail-with-body -X "$method" -H @- "$URL$path"
  echo
}

wr() { (cd "$INDEXER" && pnpm exec wrangler "$@"); }

queues() {
  local verb="$1"
  for q in "${QUEUES[@]}"; do
    if wr queues "$verb" "$q" >/dev/null 2>&1; then echo "queue $q: $verb ok"
    else echo "queue $q: $verb FAILED (the consumer guard still holds messages back)" >&2; fi
  done
}

case "$ACTION" in
  off)
    q=""
    [[ -n "$REASON" ]] && q="?reason=$(printf '%s' "$REASON" | jq -sRr @uri)"
    echo "pausing indexer at $URL"
    admin POST "/admin/indexer/pause$q"
    queues pause-delivery
    ;;
  on)
    echo "resuming queues, then indexer at $URL"
    queues resume-delivery
    admin POST /admin/indexer/resume
    ;;
  status) ;;
  *) echo "usage: $0 off [reason] | on | status" >&2; exit 2 ;;
esac

echo "--- state"
state="$(admin GET /admin/indexer/state)"
echo "$state" | jq '{paused, pausedAt, resumedAt, reason, cursor, cursorAt, poller: {running: .poller.running, paused: .poller.paused, lag: .poller.last.lag, stage: .poller.stage.name, live: .poller.live.connected}}' 2>/dev/null || echo "$state"
# `wrangler queues info` doesn't report whether delivery is paused; off/on above print each queue's result.
