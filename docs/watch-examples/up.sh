#!/bin/sh
# A service is up: GET arg 1 (an http(s) URL) with a hard timeout. Healthy (2xx or 3xx) prints nothing and exits 0; a
# known failure prints DOTZ_FAIL <kind> plus one line and exits 1: "down" (no answer within 10 s or refused) or
# "http-<status>" (e.g. http-503). Same failure twice prints the same text, so the gateway reports it once; its own
# rules apply (2 failures in a row -> one alert per 12 h, a recovery note). Nothing to remember, so no state is kept.
# Add it with: dotz_watch add {name, script: "<abs path>", on: "fail", every_minutes: 5}.
# A script watch runs without arguments: copy this into the project folder and edit the default URL, or add it as a
# command ("<path>/up.sh <url>").
url="${1:-https://example.com/health}"
code=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$url")
case "$code" in
  2??|3??) exit 0 ;;
  000) echo "DOTZ_FAIL down"; echo "$url did not answer"; exit 1 ;;
  *) echo "DOTZ_FAIL http-$code"; echo "$url answered $code"; exit 1 ;;
esac
