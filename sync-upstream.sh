#!/bin/bash
# Keep this fork current with blinksh/blink while carrying our own changes.
#
#   raw    - pure mirror of upstream/raw (fast-forward only, never commit here)
#   mwiget - our changes, rebased on top of upstream/raw
#
# Usage: ./sync-upstream.sh [--push]
#   Fetches upstream, mirrors raw, rebases mwiget onto upstream/raw and lists
#   fixes on the newest upstream release branch (v*) that mwiget doesn't have.
#   With --push, force-pushes the rebased mwiget (with lease).
set -euo pipefail

BRANCH=mwiget
UPSTREAM_URL=https://github.com/blinksh/blink.git
PUSH=0
[[ "${1:-}" == "--push" ]] && PUSH=1

cd "$(dirname "$0")"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "error: working tree has uncommitted changes" >&2
  exit 1
fi

echo "==> Fetching"
git fetch --prune upstream
git fetch --prune origin

echo "==> Mirroring upstream/raw to origin/raw"
git push origin refs/remotes/upstream/raw:refs/heads/raw

echo "==> Rebasing $BRANCH onto upstream/raw"
git checkout -q "$BRANCH"
git merge -q --ff-only "origin/$BRANCH"
before=$(git rev-parse HEAD)
# Skip when already on top: rebase would needlessly flatten merge commits.
if ! git merge-base --is-ancestor upstream/raw HEAD && ! git rebase upstream/raw; then
  echo
  echo "Rebase stopped on a conflict. Resolve it and run 'git rebase --continue'"
  echo "(or 'git rebase --abort' to go back), then rerun this script."
  exit 1
fi

echo
echo "==> Release fixes not in $BRANCH"
release=$(git for-each-ref --sort=-committerdate --count=1 --format='%(refname:short)' 'refs/remotes/upstream/v*')
missing=0
if [[ -n "$release" ]]; then
  base=$(git merge-base upstream/raw "$release")
  # '+' = no equivalent patch in $BRANCH; also skip same-subject commits and version bumps
  while read -r sign sha subject; do
    [[ "$sign" == "+" ]] || continue
    [[ "$subject" =~ ^v[0-9.]+\ build\ [0-9]+$ ]] && continue
    git log --format=%s "$BRANCH" | grep -qxF -- "$subject" && continue
    echo "  $sha $subject"
    missing=$((missing + 1))
  done < <(git cherry -v "$BRANCH" "$release" "$base")
  if [[ $missing -eq 0 ]]; then
    echo "  none (checked $release)"
  else
    echo "  ($missing on $release; take with: git cherry-pick <sha>)"
  fi
fi

echo
if [[ "$(git rev-parse HEAD)" == "$before" ]]; then
  echo "$BRANCH is already up to date with upstream/raw."
elif [[ $PUSH -eq 1 ]]; then
  echo "==> Pushing $BRANCH"
  git push --force-with-lease="$BRANCH:origin/$BRANCH" origin "$BRANCH"
else
  echo "$BRANCH was rebased. Build and test, then push with:"
  echo "  git push --force-with-lease origin $BRANCH"
fi
