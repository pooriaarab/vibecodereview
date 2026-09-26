#!/usr/bin/env bash
# Fail-closed guard scenarios (#201). Run: bash scripts/chair-verdicts-path-guard-e2e.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$ROOT/scripts/chair-verdicts-path.mjs" --assert)

fail() {
  echo "FAIL $*" >&2
  exit 1
}

pass() {
  echo "ok - $*"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NOGIT="$WORK/nogit"
mkdir -p "$NOGIT"
cd "$NOGIT"
if "${CLI[@]}" "chair-verdicts.json" 2>/dev/null; then
  fail "non-repository checkout must not pass guard"
fi
pass "non-git checkout rejected"

BROKEN="$WORK/broken"
mkdir -p "$BROKEN/.git"
cd "$BROKEN"
if "${CLI[@]}" "chair-verdicts.json" 2>/dev/null; then
  fail "broken git dir must not pass guard"
fi
pass "broken git metadata rejected"

GOOD="$WORK/good"
mkdir -p "$GOOD"
cd "$GOOD"
git init -q
git config user.email "guard-e2e@test.example"
git config user.name "Guard E2E"
echo init > README.md
git add README.md
git commit -q -m init
if ! "${CLI[@]}" "chair-verdicts.json"; then
  fail "untracked checkout-root scratch path must pass"
fi
pass "untracked scratch path allowed"

OUTSIDE="$WORK/outside-target"
mkdir -p "$OUTSIDE"
echo '{}' >"$OUTSIDE/verdicts.json"
LINK_REPO="$WORK/symlink-out"
mkdir -p "$LINK_REPO"
cd "$LINK_REPO"
git init -q
git config user.email "guard-e2e@test.example"
git config user.name "Guard E2E"
echo init > README.md
git add README.md
git commit -q -m init
ln -s "$OUTSIDE/verdicts.json" chair-verdicts.json
if "${CLI[@]}" "chair-verdicts.json" 2>/dev/null; then
  fail "symlink scratch path must be rejected"
fi
pass "symlink scratch path rejected"

TRACKED="$WORK/tracked"
mkdir -p "$TRACKED"
cd "$TRACKED"
git init -q
git config user.email "guard-e2e@test.example"
git config user.name "Guard E2E"
echo init > README.md
echo '{}' > chair-verdicts.json
git add README.md chair-verdicts.json
git commit -q -m track
if "${CLI[@]}" "chair-verdicts.json" 2>/dev/null; then
  fail "git-tracked scratch path must be rejected"
fi
pass "git-tracked scratch path rejected"

ALIAS_TRACKED="$WORK/alias-tracked"
mkdir -p "$ALIAS_TRACKED"
cd "$ALIAS_TRACKED"
git init -q
git config user.email "guard-e2e@test.example"
git config user.name "Guard E2E"
echo init > README.md
echo '{}' > chair-verdicts.json
git add README.md chair-verdicts.json
git commit -q -m track
ln -s "$ALIAS_TRACKED" "$WORK/repo-alias"
LEX_TRACKED="$WORK/repo-alias/chair-verdicts.json"
if "${CLI[@]}" "$LEX_TRACKED" 2>/dev/null; then
  fail "git-tracked path via symlink parent alias must be rejected"
fi
pass "git-tracked path via symlink parent alias rejected"

echo "chair-verdicts-path-guard-e2e passed"
