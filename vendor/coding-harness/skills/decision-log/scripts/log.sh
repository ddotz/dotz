#!/usr/bin/env bash
# Append one decision row to a TSV log, creating the header on first use.
# --check <logfile>: verify every evidence cell's commit SHAs and file paths resolve; exit 1 listing the broken ones.
set -euo pipefail

if [ "${1:-}" = "--check" ]; then
  logfile=${2:?usage: log.sh --check <logfile>}
  [ -f "$logfile" ] || { echo "no log: $logfile" >&2; exit 2; }
  root=$(git -C "$(dirname "$logfile")" rev-parse --show-toplevel 2>/dev/null || pwd)
  broken=0
  superseded=$'\n'
  single=$'\n'$(cut -f1 "$logfile" | sort | uniq -u)$'\n'
  while IFS=$'\t' read -r _ _ decision _ || [ -n "$decision" ]; do
    [[ $decision =~ ^supersedes\ ([0-9T:-]+Z): ]] && superseded+="${BASH_REMATCH[1]}"$'\n'
  done <"$logfile"
  while IFS=$'\t' read -r ts _ _ _ evidence _ || [ -n "$ts" ]; do
    [ "$ts" = ts ] && continue
    [[ $superseded == *$'\n'"$ts"$'\n'* && $single == *$'\n'"$ts"$'\n'* ]] && continue
    for token in $evidence; do
      token=${token#\'}
      token=${token%[,;]}
      token=${token%\)}
      token=${token//\`/}
      if [[ $token =~ ^[0-9a-f]{7,40}$ ]]; then
        git -C "$root" cat-file -e "$token^{commit}" 2>/dev/null || { echo "$ts: commit not found: $token"; broken=$((broken + 1)); }
      elif [[ $token == */* && $token != *://* ]]; then
        path=${token%%:[0-9]*}
        [[ $path == /* ]] || path="$root/$path"
        [ -e "$path" ] || { echo "$ts: path not found: $token"; broken=$((broken + 1)); }
      fi
    done
  done <"$logfile"
  [ "$broken" -eq 0 ] && echo "ok: all evidence resolves" || exit 1
  exit 0
fi

if [ "$#" -ne 6 ]; then
  echo "usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result> | log.sh --check <logfile>" >&2
  exit 2
fi

logfile=$1
shift

clean() {
  local v=${1//$'\t'/ }
  v=${v//$'\r'/ }
  v=${v//$'\n'/ }
  case $v in
    [=+@-]*) v="'$v" ;;
  esac
  printf '%s' "$v"
}

mkdir -p "$(dirname "$logfile")"

lockdir="$logfile.lock"
tries=0
until mkdir "$lockdir" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 3000 ]; then
    echo "log.sh: could not acquire $lockdir; remove it if no other log.sh is running" >&2
    exit 1
  fi
  sleep 0.01
done
trap 'rmdir "$lockdir"' EXIT

if [ ! -s "$logfile" ]; then
  printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' >>"$logfile"
elif [ -n "$(tail -c1 "$logfile")" ]; then
  printf '\n' >>"$logfile"
fi

row=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for cell in "$@"; do
  row+=$'\t'$(clean "$cell")
done
printf '%s\n' "$row" >>"$logfile"
