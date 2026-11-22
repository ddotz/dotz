#!/usr/bin/env bash
# why(legal): adapted from pstack worktree-audit.sh under the MIT license, https://github.com/cursor/plugins
set -u
base=""
if [ "${1:-}" = "-b" ]; then base=${2:-}; shift 2; fi
repo=${1:-$(git rev-parse --show-toplevel 2>/dev/null)}
[ -n "$repo" ] || { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
if [ -z "$base" ]; then
	for ref in origin/HEAD origin/main origin/master main master; do
		git rev-parse --verify --quiet "$ref^{commit}" >/dev/null && { base=$ref; break; }
	done
fi
[ -n "$base" ] || { echo "no base ref found; pass -b <ref>" >&2; exit 1; }
fetch="local-base"
case "$base" in
origin/HEAD) branch_name=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); branch_name=${branch_name#origin/} ;;
origin/*) branch_name=${base#origin/} ;;
*) branch_name="" ;;
esac
if [ -n "$branch_name" ]; then
	if fetch_err=$(git fetch origin "+refs/heads/$branch_name:refs/remotes/origin/$branch_name" --quiet 2>&1); then
		fetch="fetched"
	else
		fetch="stale-base"
		echo "note: fetch of origin/$branch_name failed, merged column may be stale: $(printf '%s' "$fetch_err" | head -1)" >&2
	fi
fi
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "base ref not found: $base" >&2; exit 1; }
have_gh=no
command -v gh >/dev/null 2>&1 && have_gh=yes
now=$(date +%s)
echo "# repo: $main_wt  base: $base  fetch: $fetch  gh: $have_gh"
printf "SIZE\tAGE_DAYS\tMERGED\tDIRTY\tREMOTE\tPR\tNOTE\tBUCKET\tWORKTREE\n"
git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' | while IFS= read -r wt; do
	[ "$wt" = "$main_wt" ] && continue
	if [ ! -d "$wt" ]; then
		printf -- "-\t-\t-\tmissing\t-\t-\t-\tsafe\t%s (run: git worktree prune)\n" "$wt"
		continue
	fi
	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format=%ct HEAD 2>/dev/null)
	if [ -n "$head_ts" ]; then age=$(( (now - head_ts) / 86400 )); else age="?"; fi
	if git merge-base --is-ancestor "$head" "$base" 2>/dev/null; then merged=yes; else merged=no; fi
	tracked=$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
	status_all=$(git -C "$wt" status --porcelain --ignored 2>/dev/null)
	untracked=$(printf '%s\n' "$status_all" | grep -c '^??')
	ignored=$(printf '%s\n' "$status_all" | grep -c '^!!')
	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null)
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		if [ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ]; then remote=pushed
		else
			ahead=$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)
			behind=$(git -C "$wt" rev-list --count "HEAD..origin/$branch" 2>/dev/null)
			if [ "${ahead:-0}" -gt 0 ] && [ "${behind:-0}" -gt 0 ]; then remote="ahead$ahead/behind$behind"
			elif [ "${behind:-0}" -gt 0 ]; then remote="behind$behind"
			else remote="ahead${ahead:-0}"; fi
		fi
	else remote=no-remote; fi
	notes=""
	[ "$fetch" = "stale-base" ] && notes="stale-base"
	pr="-"
	if [ "$have_gh" = yes ] && [ -n "$branch" ]; then
		if pr_out=$(cd "$wt" && gh pr list --head "$branch" --state all --limit 1 --json number,state \
			-q '.[0] // empty | "#\(.number)/\(.state | ascii_downcase)"' 2>/dev/null); then
			[ -n "$pr_out" ] && pr=$pr_out
		else
			pr="?"
			notes="${notes:+$notes,}pr-unknown"
		fi
	fi
	extra=""
	[ "$untracked" -gt 0 ] && extra="scratch:$untracked"
	[ "$ignored" -gt 0 ] && extra="${extra:+$extra,}ignored:$ignored"
	if [ "$tracked" -gt 0 ]; then dirty="wip:$tracked${extra:+,$extra}"; bucket=hold-wip
	elif [ "$pr" != "${pr%/open}" ]; then
		dirty=${extra:-clean}
		bucket=hold-open-pr
	elif [ -n "$extra" ]; then dirty=$extra; bucket=review
	else
		dirty=clean
		if [ "$merged" = yes ] || [ "$pr" != "${pr%/merged}" ]; then bucket=safe; else bucket=review; fi
	fi
	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$size" "$age" "$merged" "$dirty" "$remote" "$pr" "${notes:--}" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
