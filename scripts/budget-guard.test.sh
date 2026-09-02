#!/usr/bin/env bash
# Drive the budget guard logic that action.yml embeds.
#
# The guard decides whether a pull request gets a review at all, so both
# directions matter. Stopping a PR that is still converging costs a review;
# failing to stop one that is not costs machine time without end. The case that
# matters most is the API blip: a lookup that fails must read as "no spend yet",
# never as "out of budget".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0

# Stub `gh` on PATH and call the real scripts/budget-guard.sh, so a bug in the
# actual gh/jq pipeline (the pagination bug this file used to miss) fails the
# test, not just a copy of the arithmetic.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$GH_CASE" in
  fail) exit 1 ;;
  *) printf '%s' "$GH_BODY" ;;
esac
SH
chmod +x "$WORK/bin/gh"

review() { printf '{"user":{"login":"%s"}}' "$1"; }
page() {  # page <review-json...> -> one API page (a JSON array)
  local out="" r
  for r in "$@"; do [ -z "$out" ] || out="$out,"; out="$out$r"; done
  printf '[%s]' "$out"
}

count() {  # count <concatenated gh response body> [gh-case]
  GH_BODY="$1" GH_CASE="${2:-ok}" PATH="$WORK/bin:$PATH" \
    bash "$HERE/budget-guard.sh" o/r 1
}

check_count() {
  local want="$1" name="$2" got="$3"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else printf 'FAIL  %s (want %s, got %s)\n' "$name" "$want" "$got"; fails=$((fails + 1)); fi
}

check_count 0 'no reviews counts as zero' \
  "$(count "$(page)")"
check_count 2 'only claude[bot] reviews count' \
  "$(count "$(page "$(review claude[bot])" "$(review claude[bot])" "$(review someone-else)")")"
check_count 5 'reviews spread across pages are all counted' \
  "$(count "$(page "$(review claude[bot])" "$(review claude[bot])" "$(review claude[bot])")$(page "$(review claude[bot])" "$(review claude[bot])")")"
check_count 0 'a failed gh call fails open to zero' \
  "$(count '' fail)"

# The arithmetic on top of the count: at/over the ceiling stops the review,
# a zero ceiling disables the check.
guard() {
  local council="$1" max_council="$2"
  local over=""
  max_council="${max_council:-0}"
  if [ "$max_council" -gt 0 ] && [ "$council" -ge "$max_council" ]; then
    over="this review has already run $council times on the pull request, and the ceiling is $max_council"
  fi
  printf 'over=%s\n' "$( [ -n "$over" ] && echo true || echo false )"
}

check() {
  local want="$1" name="$2" got="$3"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else printf 'FAIL  %s (want over=%s, got over=%s)\n' "$name" "$want" "$got"; fails=$((fails + 1)); fi
}

check false 'a fresh PR is under budget'                "$(guard 0 3 | grep over= | cut -d= -f2)"
check false 'one review below the ceiling passes'       "$(guard 2 3 | grep over= | cut -d= -f2)"
check true  'at the ceiling stops the review'           "$(guard 3 3 | grep over= | cut -d= -f2)"
check true  'over the ceiling stops the review'         "$(guard 5 3 | grep over= | cut -d= -f2)"
check false 'a zero ceiling disables the check'         "$(guard 9 0 | grep over= | cut -d= -f2)"

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
