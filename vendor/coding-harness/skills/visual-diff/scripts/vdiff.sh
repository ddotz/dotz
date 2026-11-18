#!/usr/bin/env bash
# Compare a screenshot against its baseline with ImageMagick.
# Usage: vdiff.sh <baseline.png> <current.png> <diff-out.png> [fuzz%=2] [max-changed%=0.1]
# Prints one line: SAME | CHANGED <pct>% (<pixels> px) | SIZE <bw>x<bh> -> <cw>x<ch> | NO-BASELINE
# Exit: 0 = within tolerance, 1 = changed or size differs, 2 = no baseline, 3 = usage/tool error.
set -u
base=${1:-} cur=${2:-} out=${3:-} fuzz=${4:-2} max=${5:-0.1}
if [ -z "$base" ] || [ -z "$cur" ] || [ -z "$out" ]; then
	echo "usage: vdiff.sh <baseline.png> <current.png> <diff-out.png> [fuzz%] [max-changed%]" >&2
	exit 3
fi
command -v magick >/dev/null || { echo "ImageMagick (magick) not found" >&2; exit 3; }
[ -f "$cur" ] || { echo "current image missing: $cur" >&2; exit 3; }
[ -f "$base" ] || { echo "NO-BASELINE"; exit 2; }

bs=$(magick identify -format '%w %h' "$base[0]") || exit 3
cs=$(magick identify -format '%w %h' "$cur[0]") || exit 3
if [ "$bs" != "$cs" ]; then
	echo "SIZE ${bs/ /x} -> ${cs/ /x}"
	exit 1
fi
read -r w h <<<"$bs"
# compare prints the changed-pixel count to stderr and exits 1 when images differ; only >1 is an error.
px=$(magick compare -metric AE -fuzz "${fuzz}%" "$base" "$cur" "$out" 2>&1 >/dev/null | awk '{print $1}')
case "$px" in '' | *[!0-9.e+]*) echo "compare failed: $px" >&2; exit 3 ;; esac
pct=$(awk -v p="$px" -v t="$((w * h))" 'BEGIN { printf "%.4f", 100 * p / t }')
if awk -v a="$pct" -v m="$max" 'BEGIN { exit !(a <= m) }'; then
	[ "$px" = 0 ] && echo "SAME" || echo "CHANGED ${pct}% (${px} px) within ${max}%"
	exit 0
fi
echo "CHANGED ${pct}% (${px} px)"
exit 1
