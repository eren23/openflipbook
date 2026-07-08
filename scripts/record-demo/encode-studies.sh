#!/usr/bin/env bash
# Transcode each raw feature-study WebM (from record-features.ts) to a compact
# MP4 at 1.6x + dump 1 fps audit frames. Idempotent; safe to re-run.
#   ./encode-studies.sh            # all studies
#   ./encode-studies.sh wander     # one
set -euo pipefail
cd "$(dirname "$0")"
OUT=studies
only="${1:-}"

for dir in "$OUT"/raw/*/; do
  name="$(basename "$dir")"
  [ -n "$only" ] && [ "$name" != "$only" ] && continue
  webm="$(ls "$dir"/*.webm 2>/dev/null | head -1 || true)"
  if [ -z "$webm" ]; then echo "skip $name: no webm"; continue; fi
  mp4="$OUT/$name.mp4"
  frames="$OUT/frames/$name"
  mkdir -p "$frames"
  rm -f "$mp4" "$frames"/*.jpg
  # 1.6x: watchable but every beat still lands.
  ffmpeg -y -loglevel error -i "$webm" -vf "setpts=PTS/1.6" -an \
    -c:v libx264 -crf 24 -pix_fmt yuv420p "$mp4"
  # audit frames from the ORIGINAL (un-sped) capture.
  ffmpeg -y -loglevel error -i "$webm" -vf fps=1 "$frames/f_%03d.jpg"
  echo "$name → $mp4  ($(ls "$frames"/*.jpg | wc -l | tr -d ' ') frames)"
done
