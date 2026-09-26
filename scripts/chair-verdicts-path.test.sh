#!/usr/bin/env bash
# Prove the council_start chair-verdicts path is checkout-root ($PWD), not
# RUNNER_TEMP or git-dir, and that a Write to that path succeeds in a fresh repo.
set -euo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q
git config user.email "path@test.example"
git config user.name "Path Test"
echo init > README.md
git add README.md
git commit -q -m init

# Same lines as action.yml council_start (VCR_CHAIR_VERDICTS + info/exclude).
export PWD="$WORK"
printf 'VCR_CHAIR_VERDICTS=%s\n' "$PWD/.vcr-chair-verdicts.json" >> "$WORK/env.out"
printf '%s\n' /council-carry.next.md >> "$(git rev-parse --git-dir)/info/exclude"
printf '%s\n' /.vcr-chair-verdicts.json >> "$(git rev-parse --git-dir)/info/exclude"

# shellcheck disable=SC1090
source "$WORK/env.out"

case "$VCR_CHAIR_VERDICTS" in
  "$PWD/.vcr-chair-verdicts.json") ;;
  *)
    echo "FAIL VCR_CHAIR_VERDICTS must be checkout-root, got: $VCR_CHAIR_VERDICTS" >&2
    exit 1
    ;;
esac

if [[ "$VCR_CHAIR_VERDICTS" == *"/.git/"* ]]; then
  echo "FAIL path must not live under .git/: $VCR_CHAIR_VERDICTS" >&2
  exit 1
fi

printf '{"verdict":"approve","dispositions":[]}\n' >"$VCR_CHAIR_VERDICTS"
if ! test -f "$VCR_CHAIR_VERDICTS"; then
  echo "FAIL Write to checkout-root verdict path did not create file" >&2
  exit 1
fi

if ! grep -qx '/.vcr-chair-verdicts.json' "$(git rev-parse --git-dir)/info/exclude"; then
  echo "FAIL info/exclude missing /.vcr-chair-verdicts.json" >&2
  exit 1
fi

if git ls-files --error-unmatch -- "$VCR_CHAIR_VERDICTS" >/dev/null 2>&1; then
  echo "FAIL scratch verdict file must not be git-tracked" >&2
  exit 1
fi

echo "ok - checkout-root VCR_CHAIR_VERDICTS write and exclude"
