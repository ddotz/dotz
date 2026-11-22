#!/bin/sh

og_block() {
	echo "blocked by orchestrator-guard: $1; list it under External actions needed" >&2
	exit 1
}

og_real() {
	_og_real=
	_og_ifs=$IFS
	IFS=:
	for _og_d in $PATH; do
		_og_c=${_og_d:-.}/$1
		[ -f "$_og_c" ] && [ -x "$_og_c" ] || continue
		[ "$_og_c" -ef "$0" ] || [ -f "${_og_d:-.}/../worker-shim.sh" ] && continue
		_og_real=$_og_c
		break
	done
	IFS=$_og_ifs
	if [ -z "$_og_real" ]; then
		echo "orchestrator-guard shim: no $1 on PATH after ${0%/*}" >&2
		exit 127
	fi
}

og_set() {
	if [ -n "$2" ]; then
		export "$1=$2"
	else
		unset "$1"
	fi
}

og_restore() {
	case $1 in
	gh)
		[ -z "${ORCH_GUARD_SAVED_GH_CONFIG_DIR:-}" ] && return 0
		og_set GH_CONFIG_DIR "$ORCH_GUARD_SAVED_GH_CONFIG_DIR"
		og_set GH_TOKEN "${ORCH_GUARD_SAVED_GH_TOKEN:-}"
		og_set GITHUB_TOKEN "${ORCH_GUARD_SAVED_GITHUB_TOKEN:-}"
		og_set GH_ENTERPRISE_TOKEN "${ORCH_GUARD_SAVED_GH_ENTERPRISE_TOKEN:-}"
		og_set GITHUB_ENTERPRISE_TOKEN "${ORCH_GUARD_SAVED_GITHUB_ENTERPRISE_TOKEN:-}"
		;;
	npm | pnpm | yarn | bun)
		[ -z "${ORCH_GUARD_SAVED_NPM_CONFIG_USERCONFIG:-}" ] && return 0
		og_set NPM_CONFIG_USERCONFIG "$ORCH_GUARD_SAVED_NPM_CONFIG_USERCONFIG"
		og_set NPM_TOKEN "${ORCH_GUARD_SAVED_NPM_TOKEN:-}"
		og_set NODE_AUTH_TOKEN "${ORCH_GUARD_SAVED_NODE_AUTH_TOKEN:-}"
		;;
	ssh) og_set SSH_AUTH_SOCK "${ORCH_GUARD_SAVED_SSH_AUTH_SOCK:-}" ;;
	esac
}

og_exec() {
	og_real "$1"
	og_restore "$1"
	shift
	exec "$_og_real" "$@"
}

og_publish_guard() {
	_og_tool=$1
	shift
	_og_prev=
	_og_cmd=
	_og_skip=
	for _og_a in "$@"; do
		if [ "$_og_a" = -- ]; then
			[ -z "$_og_cmd" ] || return 0
			continue
		fi
		case $_og_a in
		publish) og_block "$_og_tool publish" ;;
		unpublish | deprecate | dist-tag | dist-tags | owner | author | access | token | team | org | adduser | login | logout | star | unstar | hook)
			[ "$_og_tool" = bun ] || { [ -n "$_og_cmd" ] && [ "$_og_prev" != npm ]; } || og_block "$_og_tool $_og_a"
			;;
		tag)
			if [ "$_og_tool" = yarn ] && [ "$_og_prev" = npm ]; then og_block "yarn npm tag"; fi
			;;
		esac
		if [ -n "$_og_skip" ]; then
			_og_skip=
		else
			case $_og_a in
			--prefix | -C | --workspace | -w | --registry | --userconfig | --globalconfig | --cache | --loglevel | --filter | -F | --dir | --cwd | --config | -c | --env-file | --workspace-dir | --reporter | --use-node-version) _og_skip=1 ;;
			-*) ;;
			*) _og_cmd=1 ;;
			esac
		fi
		_og_prev=$_og_a
	done
}
