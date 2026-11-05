#!/bin/sh
# dotz installer. Fresh install, upgrade (run it again) and removal:
#   curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --service          also register and start the gateway service
#   sh install.sh --uninstall [--purge]                     remove the code and the service (--purge: the data dir too)
# Steps: bun (official installer when missing) -> the agent harness (OmO by default: bun add -g omo-ai; an installed omp
# or Claude Code is detected and offered by the wizard) -> the dotz code (tarball of DOTZ_REPO@DOTZ_REF, or DOTZ_TARBALL)
# -> bun install -> a fresh data dir -> the onboarding -> the web app.
# Onboarding (docs/web-onboarding.md): a fresh install with a screen asks nothing on the terminal (besides the OmO question above). It writes a seed
# config.json, starts the gateway service, waits for it and opens the browser on a one-time local address (`setup.ts --first-run`). Over SSH, on a
# Linux box without DISPLAY/WAYLAND_DISPLAY, with --no-open, or when the browser cannot be opened, it prints that address instead (plus the
# `ssh -L` line under SSH, and `bun <code>/setup.ts` for the terminal wizard). The address is printed, never written to a file or log.
# Under WSL the browser is the Windows one (wslview, else PowerShell Start-Process) and systemd must be on: see docs/windows.md.
# --setup, --answers FILE and --no-service run the terminal wizard (setup.ts) as before; --no-setup skips onboarding.
# A re-run with an existing config.json only replaces the code and restarts the gateway (the wizard runs again with --setup). If that
# install is still waiting for its web onboarding (<data dir>/onboarding/first-run.json says pending), the re-run also restarts and prints
# or opens a new address (`setup.ts --web-link`).
#
# Self-update: the install writes a stamp (.dotz-install: source kind, repo, ref, commit sha, how it authenticated) so the
# gateway can check the repo for newer commits and swap in a new tarball itself (settings -> update). A private repo needs a
# token: with GITHUB_TOKEN the installer saves it to <data dir>/secrets/github-token (0600) for those checks; a signed-in `gh`
# is used as it is. --git installs a git clone instead (no stamp); the gateway then updates it with git fetch + fast-forward.
#
# Environment:
#   DOTZ_REPO     GitHub owner/name                     (default ddotz/dotz)
#   DOTZ_REF      branch, tag or commit                 (default main)
#   DOTZ_TARBALL  source tarball instead of GitHub: https://..., file:///abs/path.tar.gz or a local path
#   DOTZ_HOME     where the code goes                   (default ~/.local/share/dotz)
#   DOTZ_DIR      data dir (config, secrets, memory)    (default ~/.dotz)
#   DOTZ_HARNESS  omo | omp | claude | none             (default omo; none = install no harness)
#   DOTZ_GIT_URL  clone URL for --git                   (default https://github.com/$DOTZ_REPO.git)
#   DOTZ_PORT     first port to try for the web app on a fresh install; the next free one is used (default 7420)
#   DOTZ_OPEN_WAIT  seconds to wait for the gateway before opening the browser (default 30)
#   GITHUB_TOKEN / GH_TOKEN   token for a private repo (else an existing `gh` login is used)
# Options: --git --service --no-service --setup --no-setup --answers FILE --tailscale --no-open --uninstall --purge --yes
set -eu

REPO=${DOTZ_REPO:-ddotz/dotz}
REF=${DOTZ_REF:-main}
TARBALL=${DOTZ_TARBALL:-}
APP=${DOTZ_HOME:-$HOME/.local/share/dotz}
DATA=${DOTZ_DIR:-$HOME/.dotz}
HARNESS=${DOTZ_HARNESS:-omo}
LABEL=dev.dotz.gateway
UNIT=dotz-gateway.service

SERVICE=ask SETUP=auto ANSWERS='' TAILSCALE='' OPEN=--open UNINSTALL='' PURGE='' YES='' GIT=''
while [ $# -gt 0 ]; do
	case $1 in
	--git) GIT=1 ;;
	--service) SERVICE=yes ;;
	--no-service) SERVICE=no ;;
	--setup) SETUP=yes ;;
	--no-setup) SETUP=no ;;
	--answers)
		[ $# -ge 2 ] && [ -f "$2" ] || { echo "--answers needs an existing file" >&2; exit 2; }
		ANSWERS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
		shift ;;
	--tailscale) TAILSCALE=--tailscale ;;
	--no-open) OPEN= ;;
	--uninstall) UNINSTALL=1 ;;
	--purge) PURGE=1 ;;
	--yes | -y) YES=1 ;;
	-h | --help) sed -n '2,/^set -eu$/{/^set -eu$/!p;}' "$0" 2>/dev/null || echo "see the header of install.sh"; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done

say() { printf '%s\n' "dotz: $*"; }
die() { printf '%s\n' "dotz: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Questions read the terminal, not stdin: under `curl | sh` stdin is the script itself.
tty_ok() { [ -z "$YES" ] && (exec </dev/tty) 2>/dev/null; }
confirm() {
	if ! tty_ok; then [ "$2" = y ]; return; fi
	printf 'dotz: %s [%s] ' "$1" "$( [ "$2" = y ] && echo Y/n || echo y/N )" >/dev/tty
	read -r reply </dev/tty || reply=
	case ${reply:-$2} in [yY]*) return 0 ;; *) return 1 ;; esac
}

OS=$(uname -s)
case $OS in
Darwin) SVC_FILE=$HOME/Library/LaunchAgents/$LABEL.plist ;;
Linux) SVC_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT ;;
*) die "supported: macOS, Linux and Windows through WSL 2 (this is $OS). On Windows run this inside WSL: docs/windows.md" ;;
esac
WSL=
if [ "$OS" = Linux ] && { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; }; then WSL=1; fi

# The service belongs to this install only when its file runs this copy of the code; a gateway installed from another
# checkout (same label) is never stopped or restarted by this script.
ours() {
	[ -f "$SVC_FILE" ] || return 1
	grep -q "$APP/hub/main.ts" "$SVC_FILE" && return 0
	[ -d "$APP" ] && grep -q "$(cd "$APP" && pwd -P)/hub/main.ts" "$SVC_FILE"
}
svc_stop() {
	ours || return 0
	if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	else systemctl --user disable --now "$UNIT" 2>/dev/null || true; fi
}
svc_restart() {
	ours || return 0
	if [ "$OS" = Darwin ]; then set -- launchctl kickstart -k "gui/$(id -u)/$LABEL"; else set -- systemctl --user restart "$UNIT"; fi
	if "$@" 2>/dev/null; then say "gateway restarted"; else say "gateway not running (start: bun $APP/setup.ts --load)"; fi
}

if [ -n "$UNINSTALL" ]; then
	svc_stop
	if ours; then rm -f "$SVC_FILE"; say "removed $SVC_FILE"; fi
	link=$HOME/.omp/agent/extensions/dotz
	if [ -L "$link" ] && [ "$(readlink "$link")" = "$APP" ]; then rm -f "$link"; say "removed omp plugin link"; fi
	if [ -d "$APP" ]; then rm -rf "$APP"; say "removed $APP"; fi
	if [ -n "$PURGE" ]; then
		if [ -d "$DATA" ]; then rm -rf "$DATA"; say "removed data dir $DATA"; fi
	elif [ -d "$DATA" ]; then say "kept data dir $DATA (config, secrets, memory); --purge removes it"; fi
	say "the harness (omo/omp/claude) and bun stay installed"
	exit 0
fi

# The gateway is a systemd user unit; a WSL distro without systemd would otherwise fail only after the whole install.
if [ -n "$WSL" ] && [ "$SERVICE" != no ] && [ "$SETUP" != no ] && ! systemctl --user show-environment >/dev/null 2>&1; then
	die "WSL needs systemd: put [boot] and systemd=true in /etc/wsl.conf, run wsl.exe --shutdown from Windows, then run this again (docs/windows.md)"
fi

have curl || die "curl is required"
have tar || die "tar is required"

# 1. bun
BUN_BIN=${BUN_INSTALL:-$HOME/.bun}/bin
case ":$PATH:" in *":$BUN_BIN:"*) ;; *) PATH=$BUN_BIN:$PATH ;; esac
export PATH
if ! have bun; then
	say "installing bun (https://bun.sh/install)"
	have unzip || die "bun's installer needs unzip"
	curl -fsSL https://bun.sh/install | bash >/dev/null || die "bun install failed"
	have bun || die "bun not found after install (expected in $BUN_BIN)"
fi
say "bun $(bun --version)"
GLOBAL_BIN=$(bun pm bin -g 2>/dev/null || echo "$BUN_BIN")
case ":$PATH:" in *":$GLOBAL_BIN:"*) ;; *) PATH=$GLOBAL_BIN:$PATH ;; esac

# 2. harness
found=
for h in omo omp claude; do have "$h" && found="$found $h"; done
case $HARNESS in
none) ;;
omo)
	if have omo; then say "OmO $(omo --version 2>/dev/null | head -n 1)"
	elif [ -n "$found" ] && ! confirm "OmO not found (installed:$found). Install OmO (bun add -g omo-ai)?" y; then say "skipping OmO; the wizard offers$found"
	else
		say "installing OmO (bun add -g --trust omo-ai)"
		bun add -g --trust omo-ai >/dev/null 2>&1 || die "bun add -g omo-ai failed"
		have omo || die "omo not on PATH after install (bun global bin: $GLOBAL_BIN)"
		say "OmO $(omo --version 2>/dev/null | head -n 1)"
	fi ;;
omp | claude) have "$HARNESS" || die "DOTZ_HARNESS=$HARNESS but '$HARNESS' is not installed; install it first" ;;
*) die "DOTZ_HARNESS must be omo, omp, claude or none" ;;
esac

# 3. code
TMP=$(mktemp -d "${TMPDIR:-/tmp}/dotz-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
TGZ=$TMP/src.tar.gz
TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}
# What the self-update stamp records: KIND github|url, the commit SHA (empty when unknown), AUTH public|token|gh.
KIND=github AUTH=public SHA='' TARBALL_URL=''
valid_sha() { case $1 in *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 40 ]; }
sha256_of() { if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1; elif have sha256sum; then sha256sum "$1" | cut -d' ' -f1; fi; }
if [ -n "$GIT" ]; then
	have git || die "--git needs git"
	[ -z "$TARBALL" ] || die "--git and DOTZ_TARBALL cannot be combined"
	GIT_URL=${DOTZ_GIT_URL:-https://github.com/$REPO.git}
	SRC="$GIT_URL@$REF (git clone)"
	CLONE=$TMP/clone
	export GIT_TERMINAL_PROMPT=0
	if [ -n "$TOKEN" ]; then
		B64=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')
		git -c "http.extraHeader=Authorization: Basic $B64" clone --quiet "$GIT_URL" "$CLONE" || die "git clone failed with GITHUB_TOKEN: $SRC (token without read access to $REPO?)"
		say "cloned with the token; the token is not stored in the clone. For 'git fetch' (self-update) in a private repo run: gh auth setup-git"
	elif git clone --quiet "$GIT_URL" "$CLONE" 2>"$TMP/clone.err"; then :
	elif have gh && gh auth status >/dev/null 2>&1; then
		rm -rf "$CLONE"
		gh repo clone "$REPO" "$CLONE" -- --quiet || die "gh could not clone $REPO"
	else
		die "cannot clone $SRC: $(tail -n 1 "$TMP/clone.err"). If the repo is private, sign in with 'gh auth login' or set GITHUB_TOKEN"
	fi
	git -C "$CLONE" checkout --quiet "$REF" || die "ref $REF not found in $SRC"
	TOP=$CLONE
else
	if [ -n "$TARBALL" ]; then
		KIND=url AUTH=public
		case $TARBALL in
		file://*) cp "${TARBALL#file://}" "$TGZ" || die "cannot read $TARBALL"; TARBALL_URL=$TARBALL ;;
		http://* | https://*)
			TARBALL_URL=$TARBALL
			if [ -n "$TOKEN" ]; then AUTH=token; curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$TGZ" "$TARBALL" || die "download failed: $TARBALL"
			else curl -fsSL -o "$TGZ" "$TARBALL" || die "download failed: $TARBALL"; fi ;;
		*) cp "$TARBALL" "$TGZ" || die "cannot read $TARBALL"; TARBALL_URL=$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL") ;;
		esac
		SRC=$TARBALL
		SHA=$(sha256_of "$TGZ")
	else
		SRC="github.com/$REPO@$REF"
		API=https://api.github.com/repos/$REPO
		# The commit is resolved first and the tarball fetched by that SHA, so the stamp is exactly what was installed.
		if [ -n "$TOKEN" ]; then
			AUTH=token
			SHA=$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.sha" "$API/commits/$REF" 2>/dev/null || true)
			valid_sha "$SHA" || SHA=
			curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$TGZ" "$API/tarball/${SHA:-$REF}" || die "download failed with GITHUB_TOKEN: $SRC (token without read access to $REPO?)"
		else
			SHA=$(curl -fsSL -H "Accept: application/vnd.github.sha" "$API/commits/$REF" 2>/dev/null || true)
			valid_sha "$SHA" || SHA=
			if curl -fsSL -o "$TGZ" "https://codeload.github.com/$REPO/tar.gz/${SHA:-$REF}" 2>/dev/null; then :
			elif have gh && gh auth status >/dev/null 2>&1; then
				AUTH=gh
				SHA=$(gh api -H "Accept: application/vnd.github.sha" "repos/$REPO/commits/$REF" 2>/dev/null || true)
				valid_sha "$SHA" || SHA=
				gh api "repos/$REPO/tarball/${SHA:-$REF}" >"$TGZ" || die "gh could not download $SRC"
			else
				die "cannot download $SRC: the repo is private or the ref does not exist. Sign in with 'gh auth login' or set GITHUB_TOKEN, or point DOTZ_TARBALL at a tarball"
			fi
		fi
	fi
	mkdir "$TMP/x"
	tar -xzf "$TGZ" -C "$TMP/x" || die "not a .tar.gz: $SRC"
	# GitHub tarballs (and git archive --prefix) wrap everything in one top folder.
	TOP=$TMP/x
	set -- "$TMP"/x/*
	[ $# -eq 1 ] && [ -d "$1" ] && TOP=$1
	# The API tarball's folder is <owner>-<repo>-<sha>: the SHA when it could not be asked for.
	if [ -z "$SHA" ] && [ "$KIND" = github ]; then
		name=$(basename "$TOP")
		sfx=${name#"$(printf %s "$REPO" | tr / -)-"}
		if [ "$sfx" != "$name" ] && [ "${#sfx}" -ge 7 ]; then case $sfx in *[!0-9a-f]*) ;; *) SHA=$sfx ;; esac; fi
	fi
fi
[ -f "$TOP/setup.ts" ] && [ -f "$TOP/hub/main.ts" ] || die "$SRC does not look like dotz (no setup.ts / hub/main.ts)"

UPGRADE=
[ -d "$APP" ] && UPGRADE=1
mkdir -p "$(dirname "$APP")"
rm -rf "$APP.new" "$APP.old"
mv "$TOP" "$APP.new"
[ -n "$UPGRADE" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$APP.old"
# A git clone needs no stamp (git knows its commit; an untracked file would also make it look dirty).
if [ -z "$GIT" ]; then
	# The release version of these files (VERSION at the root), so a tarball install checks tags, not commits.
	VERSION_STR=
	[ -f "$APP/VERSION" ] && VERSION_STR=$(head -n 1 "$APP/VERSION" | tr -d '[:space:]')
	{
		printf 'source=%s\nkind=%s\n' "$SRC" "$KIND"
		[ "$KIND" = github ] && printf 'repo=%s\nref=%s\n' "$REPO" "$REF"
		[ -n "$TARBALL_URL" ] && printf 'tarball=%s\n' "$TARBALL_URL"
		[ -n "$VERSION_STR" ] && printf 'version=%s\n' "$VERSION_STR"
		printf 'sha=%s\nauth=%s\ninstalled=%s\n' "$SHA" "$AUTH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$APP/.dotz-install"
else
	# Marks this clone as an install, not a developer checkout: self-update may save local work and move to upstream on its own.
	printf 'install.sh --git\n' >"$APP/.git/dotz-install"
fi
say "$([ -n "$UPGRADE" ] && echo upgraded || echo installed) $SRC -> $APP"

# 4. deps (dotz itself has none today; this keeps a future package.json working)
(cd "$APP" && bun install --production >/dev/null 2>&1) || die "bun install failed in $APP"

# 5. data dir: only the folder; setup.ts writes config.json and the gateway its templates on first start.
mkdir -p "$DATA"
chmod 700 "$DATA"
# The token that worked is kept (0600) for the gateway's update checks of a private repo; it has no other use.
if [ "$AUTH" = token ] && [ -z "$GIT" ]; then
	mkdir -p "$DATA/secrets"
	chmod 700 "$DATA/secrets"
	(umask 077; printf '%s\n' "$TOKEN" >"$DATA/secrets/github-token")
	chmod 600 "$DATA/secrets/github-token"
	say "token saved to $DATA/secrets/github-token (self-update checks of the private repo)"
fi

# 6. onboarding: in the browser (WEB=first on a fresh install, WEB=link while the first-run marker is pending) or the terminal wizard
WEB=
if [ "$SETUP" = auto ]; then
	if [ -f "$DATA/config.json" ]; then
		if grep -q '"status": *"pending"' "$DATA/onboarding/first-run.json" 2>/dev/null; then
			if [ -n "$ANSWERS" ] || [ "$SERVICE" = no ]; then SETUP=yes; else WEB=link; fi
		else SETUP=no; fi
	elif [ -n "$ANSWERS" ] || [ "$SERVICE" = no ]; then SETUP=yes
	else WEB=first; fi
fi
if [ "$SETUP" = no ]; then
	[ -n "$UPGRADE" ] && svc_restart
	say "done. Wizard again: bun $APP/setup.ts"
	exit 0
fi
if [ -n "$WEB" ]; then
	PORT=${DOTZ_PORT:-7420}
	case $PORT in '' | *[!0-9]*) die "DOTZ_PORT must be a port number" ;; esac
	cd "$APP"
	# The output is held in a variable: it carries the one-time token, which must not reach a file or log.
	if [ "$WEB" = link ]; then
		svc_restart
		OUT=$(DOTZ_DIR=$DATA bun setup.ts --web-link --dir "$DATA") || die "could not issue a setup address"
	else
		OUT=$(DOTZ_DIR=$DATA bun setup.ts --first-run --port "$PORT" --load --dir "$DATA") || die "first-run setup failed"
	fi
	URL=$(printf '%s\n' "$OUT" | sed -n 's/^setup-url: //p' | head -n 1)
	printf '%s\n' "$OUT" | grep -v '^setup-url: ' || true
	[ -n "$URL" ] || die "setup.ts printed no setup address"
	P=${URL#http://127.0.0.1:}
	P=${P%%/*}
	MODE=open
	[ -n "$OPEN" ] || MODE=print
	[ -z "${SSH_CONNECTION:-}" ] || MODE=print
	if [ "$OS" = Linux ] && [ -z "$WSL" ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then MODE=print; fi
	if [ "$MODE" = open ]; then
		UP= i=0
		while [ "$i" -lt "${DOTZ_OPEN_WAIT:-30}" ]; do
			if curl -s -o /dev/null -m 2 "http://127.0.0.1:$P/api/peer-info"; then UP=1; break; fi
			i=$((i + 1))
			sleep 1
		done
		set -- open "$URL"
		if [ -n "$WSL" ]; then
			if have wslview; then set -- wslview "$URL"; else set -- powershell.exe -NoProfile -Command "Start-Process '$URL'"; fi
		elif [ "$OS" = Linux ]; then set -- xdg-open "$URL"; fi
		if [ -z "$UP" ]; then say "the gateway is not answering yet"; MODE=print
		elif have "$1" && "$@" >/dev/null 2>&1; then say "opened the setup page in your browser"
		else MODE=print; fi
	fi
	if [ "$MODE" = print ]; then
		say "open this address on this computer to finish setup (one use, valid 24 h):"
		printf '%s\n' "$URL"
		if [ -n "${SSH_CONNECTION:-}" ]; then say "from your own computer: ssh -L $P:127.0.0.1:$P $(id -un)@$(hostname), then open the address there"; fi
		say "or answer in the terminal instead: bun $APP/setup.ts"
	fi
	say "done. Code: $APP  Data: $DATA  Upgrade: run this installer again"
	exit 0
fi
LOAD=
case $SERVICE in
yes) LOAD=--load ;;
ask) confirm "Register the gateway as a login service ($( [ "$OS" = Darwin ] && echo launchd || echo systemd)) and start it?" y && LOAD=--load ;;
esac
cd "$APP"
if [ -n "$ANSWERS" ]; then
	DOTZ_DIR=$DATA bun setup.ts --dir "$DATA" --answers "$ANSWERS" $LOAD $TAILSCALE $OPEN
elif (exec </dev/tty) 2>/dev/null; then
	DOTZ_DIR=$DATA bun setup.ts --dir "$DATA" $LOAD $TAILSCALE $OPEN </dev/tty
else
	say "no terminal for the wizard; run it yourself: cd $APP && bun setup.ts${LOAD:+ $LOAD}"
	exit 0
fi
say "done. Code: $APP  Data: $DATA  Wizard again: bun $APP/setup.ts  Upgrade: run this installer again"
