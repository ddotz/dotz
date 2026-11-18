#!/bin/sh
. "${0%/*}/worker-shim.sh"

og_git_ssh_allowed() {
	_og_probe=
	while [ "$#" -gt 0 ]; do
		case $1 in
		-4 | -6 | -oSendEnv=GIT_PROTOCOL) ;;
		-G) _og_probe=1 ;;
		-o)
			[ "$#" -ge 2 ] && [ "$2" = SendEnv=GIT_PROTOCOL ] || return 1
			shift
			;;
		-p)
			[ "$#" -ge 2 ] || return 1
			case $2 in '' | *[!0-9]*) return 1 ;; esac
			shift
			;;
		-p?*)
			case ${1#-p} in *[!0-9]*) return 1 ;; esac
			;;
		-*) return 1 ;;
		*) break ;;
		esac
		shift
	done
	[ "$#" -ge 1 ] || return 1
	shift
	if [ -n "$_og_probe" ]; then
		[ "$#" -eq 0 ]
		return
	fi
	[ "$#" -eq 1 ] || return 1
	case $1 in
	"git-upload-pack '"* | "git-upload-archive '"*) ;;
	*) return 1 ;;
	esac
	_og_body=${1#*\'}
	case $_og_body in
	*\') _og_body=${_og_body%\'} ;;
	*) return 1 ;;
	esac
	case $_og_body in *\'*) return 1 ;; esac
}

og_git_ssh_allowed "$@" || og_block "ssh other than git-upload-pack or git-upload-archive with the options git passes"
og_exec ssh "$@"
