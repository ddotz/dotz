# worker-env.sh: sourced (`. worker-env.sh`) at the start of every bash command a worker (task subagent) runs.
# orchestrator-guard prepends the sourcing line, so make, `bun run` and scripts inherit what is set here.
# Layer 1 of the worker boundary: external-impact actions fail however they are invoked, while the string patterns in
# extensions/orchestrator-guard.ts (layer 2) only see the text of the command. POSIX sh. Idempotent: the marker makes
# every later source in the same (persistent) shell a no-op.
#
# git push: every push URL is rewritten to a scheme without a remote helper, so a push to a network remote dies with
# "remote helper 'blocked-by-orchestrator-guard' aborted session" before it opens a connection. The empty prefix
# covers https, http, ssh, git and scp-style remotes of any user (git@h:r, deploy@h:r, h:r). The longest matching
# prefix wins, so `/`, `.` and `file://` rewrite to themselves and pushes to a local repository keep working. Fetch,
# clone and ls-remote never read pushInsteadOf. Not covered: a remote with its own `pushurl`, a user or repo
# `url.*.pushInsteadOf` rule with a longer prefix (it wins the match), and a bare relative path without ./ (blocked).
#
# wrangler: an invalid API token, global key and email. wrangler prefers a global key and email over the token, and one
# left unset could be supplied by a project .env, so all of them are set. CLOUDFLARE_ACCOUNT_ID stays as it is.
# why(vendor): CLOUDFLARE_API_TOKEN outranks the OAuth login, so authenticated wrangler reads (whoami, tail, d1/kv/r2 --remote, deployments list) fail in workers too.
# why(vendor): a local push runs `unset GIT_CONFIG_COUNT GIT_PREFIX; git-receive-pack ...` (seen with GIT_TRACE=1) and git's local_repo_env (environment.c) also drops GIT_CONFIG_PARAMETERS, so the hooks of the receiving repository only inherit GIT_CONFIG_GLOBAL: a private gitconfig in TMPDIR that includes the user's global config and carries the same push rules.
#
if [ -z "${ORCH_GUARD_WORKER_ENV_ACTIVE:-}" ]; then
	_og_n=${GIT_CONFIG_COUNT:-0}
	case $_og_n in '' | *[!0-9]*) _og_n=0 ;; esac
	_og_priv=${TMPDIR:-/tmp}
	_og_priv=${_og_priv%/}/orchestrator-guard-$(id -u 2>/dev/null)
	mkdir -m 700 "$_og_priv" 2>/dev/null
	if [ -d "$_og_priv" ] && [ ! -L "$_og_priv" ] && [ -O "$_og_priv" ] && chmod 700 "$_og_priv" 2>/dev/null; then :; else _og_priv=; fi
	_og_cfg=$(mktemp "${_og_priv:-${TMPDIR:-/tmp}}/orchestrator-guard-gitconfig.XXXXXX" 2>/dev/null) || _og_cfg=
	if [ -n "${GIT_CONFIG_GLOBAL:-}" ]; then
		_og_a=$GIT_CONFIG_GLOBAL
		_og_b=
	else
		_og_a=${HOME:+$HOME/.gitconfig}
		_og_b=${XDG_CONFIG_HOME:-${HOME:+$HOME/.config}}
		_og_b=${_og_b:+$_og_b/git/config}
	fi
	for _og_p in "$_og_a" "$_og_b"; do
		[ -n "$_og_cfg" ] && [ -n "$_og_p" ] || continue
		case $_og_p in
		*[\"\\]*)
			rm -f "$_og_cfg"
			_og_cfg=
			;;
		*) printf '[include]\n\tpath = "%s"\n' "$_og_p" >>"$_og_cfg" ;;
		esac
	done
	_og_rule() {
		export "GIT_CONFIG_KEY_$_og_n=url.$1.pushInsteadOf" "GIT_CONFIG_VALUE_$_og_n=$2"
		_og_n=$((_og_n + 1))
		[ -z "$_og_cfg" ] || printf '[url "%s"]\n\tpushInsteadOf = %s\n' "$1" "$2" >>"$_og_cfg"
	}
	_og_rule blocked-by-orchestrator-guard:// ''
	_og_rule / /
	_og_rule . .
	_og_rule file:// file://
	export GIT_CONFIG_COUNT=$_og_n
	if [ -n "$_og_cfg" ] && [ -n "$_og_priv" ]; then
		_og_v=$(cksum <"$_og_cfg" 2>/dev/null | tr ' ' -) && [ -n "$_og_v" ] && _og_v=$_og_priv/gitconfig-$_og_v
		if [ -n "$_og_v" ] && [ -f "$_og_v" ] && cmp -s "$_og_cfg" "$_og_v"; then
			rm -f "$_og_cfg"
			_og_cfg=$_og_v
		elif [ -n "$_og_v" ] && mv -f "$_og_cfg" "$_og_v" 2>/dev/null; then
			_og_cfg=$_og_v
		fi
	fi
	[ -z "$_og_cfg" ] || export GIT_CONFIG_GLOBAL=$_og_cfg
	unset -f _og_rule
	unset _og_n _og_cfg _og_a _og_b _og_p _og_v
	export CLOUDFLARE_API_TOKEN=blocked-by-orchestrator-guard CLOUDFLARE_API_KEY=blocked-by-orchestrator-guard CF_API_KEY=blocked-by-orchestrator-guard
	export CLOUDFLARE_EMAIL=blocked-by-orchestrator-guard@invalid CF_EMAIL=blocked-by-orchestrator-guard@invalid
	_og_src=${BASH_SOURCE:-}
	[ -z "$_og_src" ] && [ -n "${ZSH_VERSION:-}" ] && eval '_og_src=${(%):-%x}'
	_og_n=0
	while [ -L "$_og_src" ] && [ "$_og_n" -lt 40 ]; do
		_og_l=$(readlink "$_og_src") || break
		case $_og_l in
		/*) _og_src=$_og_l ;;
		*)
			case $_og_src in
			*/*) _og_src=${_og_src%/*}/$_og_l ;;
			*) _og_src=$_og_l ;;
			esac
			;;
		esac
		_og_n=$((_og_n + 1))
	done
	case $_og_src in
	*/*) _og_dir=${_og_src%/*} ;;
	'') _og_dir=${HOME:-}/.omp/agent/harness ;;
	*) _og_dir=. ;;
	esac
	case $_og_dir in /*) ;; *) _og_dir=$(cd "$_og_dir" 2>/dev/null && pwd) ;; esac
	_og_bin=$_og_dir/worker-bin
	if [ ! -d "$_og_bin" ]; then
		_og_dir=${HOME:-}/.omp/agent/harness
		_og_bin=$_og_dir/worker-bin
	fi
	_og_gh=
	if [ -n "$_og_priv" ] && mkdir -p -m 700 "$_og_priv/gh" 2>/dev/null && [ ! -L "$_og_priv/gh" ] && [ -z "$(ls -A "$_og_priv/gh" 2>/dev/null)" ]; then _og_gh=$_og_priv/gh; fi
	[ -n "$_og_gh" ] || _og_gh=$(mktemp -d "${TMPDIR:-/tmp}/orchestrator-guard-gh.XXXXXX" 2>/dev/null) || _og_gh=/dev/null/gh
	_og_npmrc=
	if [ -n "$_og_priv" ] && [ ! -L "$_og_priv/npmrc" ] && : >>"$_og_priv/npmrc" 2>/dev/null && [ ! -s "$_og_priv/npmrc" ]; then _og_npmrc=$_og_priv/npmrc; fi
	[ -n "$_og_npmrc" ] || _og_npmrc=$(mktemp "${TMPDIR:-/tmp}/orchestrator-guard-npmrc.XXXXXX" 2>/dev/null) || _og_npmrc=/dev/null
	_og_v=${GH_CONFIG_DIR:-}
	[ -n "$_og_v" ] || { [ -z "${XDG_CONFIG_HOME:-}" ] || _og_v=$XDG_CONFIG_HOME/gh; }
	[ -n "$_og_v" ] || _og_v=${HOME:-}/.config/gh
	export ORCH_GUARD_SAVED_GH_CONFIG_DIR="$_og_v" ORCH_GUARD_SAVED_GH_TOKEN="${GH_TOKEN:-}" ORCH_GUARD_SAVED_GITHUB_TOKEN="${GITHUB_TOKEN:-}"
	export ORCH_GUARD_SAVED_GH_ENTERPRISE_TOKEN="${GH_ENTERPRISE_TOKEN:-}" ORCH_GUARD_SAVED_GITHUB_ENTERPRISE_TOKEN="${GITHUB_ENTERPRISE_TOKEN:-}"
	unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
	export GH_CONFIG_DIR="$_og_gh"
	_og_v=${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-}}
	[ -n "$_og_v" ] || _og_v=${HOME:-}/.npmrc
	export ORCH_GUARD_SAVED_NPM_CONFIG_USERCONFIG="$_og_v" ORCH_GUARD_SAVED_NPM_TOKEN="${NPM_TOKEN:-}" ORCH_GUARD_SAVED_NODE_AUTH_TOKEN="${NODE_AUTH_TOKEN:-}"
	unset NPM_TOKEN NODE_AUTH_TOKEN npm_config_userconfig
	export NPM_CONFIG_USERCONFIG="$_og_npmrc"
	export ORCH_GUARD_SAVED_SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}"
	unset SSH_AUTH_SOCK
	if [ -d "$_og_bin" ]; then
		if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "${GIT_SSH:-}" ] && [ -x "$_og_dir/worker-git-ssh.sh" ]; then
			case $_og_dir in
			*"'"*) ;;
			*) export GIT_SSH_COMMAND="'$_og_dir/worker-git-ssh.sh'" ;;
			esac
		fi
		export ORCH_GUARD_WORKER_BIN="$_og_bin"
	fi
	unset _og_src _og_dir _og_bin _og_gh _og_npmrc _og_v _og_n _og_l _og_priv
	ORCH_GUARD_WORKER_ENV_ACTIVE=1
	export ORCH_GUARD_WORKER_ENV_ACTIVE
fi
if [ -n "${ORCH_GUARD_WORKER_BIN:-}" ] && [ -d "$ORCH_GUARD_WORKER_BIN" ]; then
	_og_rest=
	_og_p=$PATH:
	while [ -n "$_og_p" ]; do
		_og_d=${_og_p%%:*}
		_og_p=${_og_p#*:}
		[ "${_og_d%/}" = "$ORCH_GUARD_WORKER_BIN" ] || _og_rest=${_og_rest:+$_og_rest:}$_og_d
	done
	case :$_og_rest: in
	*:/opt/homebrew/bin:* | *:/opt/homebrew/bin/:*) ;;
	*) [ ! -d /opt/homebrew/bin ] || _og_rest=${_og_rest:+$_og_rest:}/opt/homebrew/bin ;;
	esac
	PATH=$ORCH_GUARD_WORKER_BIN${_og_rest:+:$_og_rest}
	export PATH
	unset _og_rest _og_p _og_d
fi
