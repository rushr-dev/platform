#!/usr/bin/env bash
# Publish the open parts of this repo to their public GitHub repos:
#   packages/core -> rushr-dev/rushr-core  (history kept via git subtree split)
#   contracts     -> rushr-dev/contracts   (history kept via git subtree split)
#   registry JSON -> rushr-dev/registry    (generated from packages/core)
#   oss/profile   -> rushr-dev/rushr-dev   (account profile README)
# Run after committing to main: pnpm publish:oss
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ "$(git branch --show-current)" = main ] || { echo "publish from main only"; exit 1; }
[ -z "$(git status --porcelain -- packages/core oss)" ] || { echo "commit packages/core and oss first"; exit 1; }

export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519_rushr -o IdentitiesOnly=yes"
NAME=rushr-dev
EMAIL=355387833+rushr-dev@users.noreply.github.com
remote() { echo "git@github.com:rushr-dev/$1.git"; }

echo "== rushr-core"
git subtree split --prefix packages/core -b core-mirror -q
git push "$(remote rushr-core)" core-mirror:main

echo "== contracts"
git subtree split --prefix contracts -b contracts-mirror -q
git push "$(remote contracts)" contracts-mirror:main

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Clone a public repo, let $2 fill it, commit only if something changed.
sync() {
  local repo=$1 fill=$2 msg=$3 dir="$TMP/$1"
  echo "== $repo"
  git clone -q "$(remote "$repo")" "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  $fill "$dir"
  git -C "$dir" add -A
  if git -C "$dir" diff --cached --quiet; then echo "unchanged"; return; fi
  git -C "$dir" -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "$msg"
  git -C "$dir" push -q origin HEAD:main
  echo "pushed"
}
fill_registry() { node packages/core/scripts/export-registry.ts "$1" >/dev/null; cp oss/registry/README.md "$1/"; }
fill_profile() { cp oss/profile/README.md "$1/"; }

sync registry fill_registry "Update registry"
sync rushr-dev fill_profile "Update profile"
