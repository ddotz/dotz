#!/bin/sh
# A page or value changed: prints one line when the content of arg 1 (http(s) URL, file:// URL or file path) differs from
# the last run, nothing otherwise. The sha256 of the last content lives in $DOTZ_WATCH_STATE_DIR/hash; the first run only
# records it. Add it with: dotz_watch add {name, script: "<abs path>", on: "match", pattern: "."}.
# Known failure: DOTZ_FAIL fetch (could not read it), exit 1.
# A script watch runs without arguments: copy this into the project folder and edit the default source, or add it as a
# command ("<path>/changed.sh <source>").
src="${1:-https://example.com/pricing}"
state="${DOTZ_WATCH_STATE_DIR:?run it as a dotz_watch script}"
mkdir -p "$state"
case "$src" in
  http://*|https://*) body=$(curl -fsS --max-time 20 "$src") || { echo "DOTZ_FAIL fetch"; echo "could not fetch $src"; exit 1; } ;;
  file://*) body=$(cat "${src#file://}") || { echo "DOTZ_FAIL fetch"; echo "could not read $src"; exit 1; } ;;
  *) body=$(cat "$src") || { echo "DOTZ_FAIL fetch"; echo "could not read $src"; exit 1; } ;;
esac
now=$(printf '%s' "$body" | shasum -a 256 | cut -c1-16)
if [ -f "$state/hash" ] && [ "$(cat "$state/hash")" != "$now" ]; then echo "changed: $src ($now)"; fi
echo "$now" > "$state/hash"
exit 0
