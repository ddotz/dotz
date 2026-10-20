#!/bin/sh
# New items since the last run, from a JSON feed: a file path, file:// URL or http(s) URL (arg 1) holding an array of
# {"id": <number>, "title": "..."}. Prints one "<id> <title>" line per new item and nothing when there is none; the last
# seen id lives in $DOTZ_WATCH_STATE_DIR/last-id. The first run only records the baseline (no flood of old items).
# Add it with: dotz_watch add {name, script: "<abs path>", on: "match", pattern: "."}  (silent until there is news).
# Known failures: DOTZ_FAIL fetch (could not read the feed), DOTZ_FAIL feed (not the expected JSON), exit 1.
# A script watch runs without arguments: copy this into the project folder and edit the default source, or add it as a
# command ("<path>/new-items.sh <source>").
src="${1:-https://example.com/feed.json}"
state="${DOTZ_WATCH_STATE_DIR:?run it as a dotz_watch script}"
mkdir -p "$state"
case "$src" in
  http://*|https://*) body=$(curl -fsS --max-time 20 "$src") || { echo "DOTZ_FAIL fetch"; echo "could not fetch $src"; exit 1; } ;;
  file://*) body=$(cat "${src#file://}") || { echo "DOTZ_FAIL fetch"; echo "could not read $src"; exit 1; } ;;
  *) body=$(cat "$src") || { echo "DOTZ_FAIL fetch"; echo "could not read $src"; exit 1; } ;;
esac
newest=$(printf '%s' "$body" | jq -er 'map(.id) | max // 0') || { echo "DOTZ_FAIL feed"; echo "$src is not an array of {id,title}"; exit 1; }
if [ ! -f "$state/last-id" ]; then echo "$newest" > "$state/last-id"; exit 0; fi
last=$(cat "$state/last-id")
printf '%s' "$body" | jq -r --argjson last "$last" 'map(select(.id > $last)) | sort_by(.id)[] | "\(.id) \(.title)"'
[ "$newest" -gt "$last" ] && echo "$newest" > "$state/last-id"
exit 0
