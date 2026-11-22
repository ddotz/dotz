#!/usr/bin/env bash
set -euo pipefail
run_id=${1:?usage: bombadil.sh <run-id> [time-limit, default 45s]}
limit=${2:-45s}
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
run="$repo/.omp/verify/runs/$run_id"
tree=$(jq -r .tree "$run/run.json")
port=$(jq -r .port "$run/run.json")
cookie=$(jq -r .loginCookie "$run/run.json")
if [ "$tree" != head ]; then
	echo "bombadil clicks every button (업데이트 included): launch the run with --tree head so no click can reach the checkout" >&2
	exit 2
fi
if [ "$port" = 7420 ]; then
	echo "refused: port 7420 is the owner's gateway" >&2
	exit 2
fi
shell=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell | tail -1)
export CHROME="$shell"
set +e
bombadil browser test --headless --time-limit "$limit" --exit-on-violation \
	--cookie "dotz_local=$cookie" \
	--output-path "$run/bombadil" \
	"http://localhost:$port/" >"$run/bombadil.out" 2>&1
code=$?
set -e
echo "bombadil exit $code; output $run/bombadil.out; trace $run/bombadil/trace.jsonl ($(wc -l <"$run/bombadil/trace.jsonl" 2>/dev/null || echo 0) states)"
exit $code
