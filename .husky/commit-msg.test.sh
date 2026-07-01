#!/usr/bin/env sh
# Runnable check for the commit-msg hook. Run: sh .husky/commit-msg.test.sh
set -e
hook="$(dirname "$0")/commit-msg"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.tmp"' EXIT

# 1. Co-authored-by line is stripped; other lines survive.
printf 'feat: thing\n\nbody line\nCo-authored-by: omnigent <noreply@omnigent.ai>\n' > "$tmp"
sh -e "$hook" "$tmp"
grep -qi 'co-authored-by' "$tmp" && { echo "FAIL: trailer survived"; exit 1; }
grep -q 'body line' "$tmp" || { echo "FAIL: body line dropped"; exit 1; }

# 2. No-trailer message is left byte-for-byte identical.
printf 'fix: no trailer here\n\ndetails\n' > "$tmp"
before="$(cat "$tmp")"
sh -e "$hook" "$tmp"
[ "$before" = "$(cat "$tmp")" ] || { echo "FAIL: no-trailer message altered"; exit 1; }

# 3. Trailer-only message -> empty, hook still exits 0, no stray .tmp left behind.
printf 'Co-authored-by: omnigent <noreply@omnigent.ai>\n' > "$tmp"
sh -e "$hook" "$tmp"
[ -s "$tmp" ] && { echo "FAIL: trailer-only message not emptied"; exit 1; }
[ -e "$tmp.tmp" ] && { echo "FAIL: stray .tmp left behind"; exit 1; }

echo "ok"
