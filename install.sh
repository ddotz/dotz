#!/bin/sh
# dotz installer. Fresh install, upgrade (run it again) and removal:
#   curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --service          also register and start the gateway service
#   sh install.sh --uninstall [--purge]                     remove the code and the service (--purge: the data dir too)
# Steps: bun (official installer when missing) -> the agent harness (OmO by default: bun add -g omo-ai; an installed omp
# or Claude Code is detected and offered by the wizard) -> the dotz code (tarball of DOTZ_REPO@DOTZ_REF, or DOTZ_TARBALL)
# -> bun install -> a fresh data dir -> the onboarding wizard (setup.ts) on the terminal -> the web app.
# A re-run with an existing config.json only replaces the code and restarts the gateway (the wizard runs again with --setup).
#
# Environment:
#   DOTZ_REPO     GitHub owner/name                     (default ddotz/dotz)
#   DOTZ_REF      branch, tag or commit                 (default main)
#   DOTZ_TARBALL  source tarball instead of GitHub: https://..., file:///abs/path.tar.gz or a local path
#   DOTZ_HOME     where the code goes                   (default ~/.local/share/dotz)
#   DOTZ_DIR      data dir (config, secrets, memory)    (default ~/.dotz)
#   DOTZ_HARNESS  omo | omp | claude | none             (default omo; none = install no harness)
#   GITHUB_TOKEN / GH_TOKEN   token for a private repo (else an existing `gh` login is used)
# Options: --service --no-service --setup --no-setup --answers FILE --tailscale --no-open --uninstall --purge --yes
set -eu

REPO=${DOTZ_REPO:-ddotz/dotz}
REF=${DOTZ_REF:-main}
TARBALL=${DOTZ_TARBALL:-}
APP=${DOTZ_HOME:-$HOME/.local/share/dotz}
DATA=${DOTZ_DIR:-$HOME/.dotz}
HARNESS=${DOTZ_HARNESS:-omo}
LABEL=dev.dotz.gateway
UNIT=dotz-gateway.service

SERVICE=ask SETUP=auto ANSWERS='' TAILSCALE='' OPEN=--open UNINSTALL='' PURGE='' YES=''
while [ $# -gt 0 ]; do
	case $1 in
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
	-h | --help) sed -n '2,21p' "$0" 2>/dev/null || echo "see the header of install.sh"; exit 0 ;;
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
*) die "supported: macOS and Linux (this is $OS)" ;;
esac

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
if [ -n "$TARBALL" ]; then
	case $TARBALL in
	file://*) cp "${TARBALL#file://}" "$TGZ" || die "cannot read $TARBALL" ;;
	http://* | https://*)
		if [ -n "$TOKEN" ]; then curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$TGZ" "$TARBALL" || die "download failed: $TARBALL"
		else curl -fsSL -o "$TGZ" "$TARBALL" || die "download failed: $TARBALL"; fi ;;
	*) cp "$TARBALL" "$TGZ" || die "cannot read $TARBALL" ;;
	esac
	SRC=$TARBALL
else
	SRC="github.com/$REPO@$REF"
	API=https://api.github.com/repos/$REPO/tarball/$REF
	if [ -n "$TOKEN" ]; then
		curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$TGZ" "$API" || die "download failed with GITHUB_TOKEN: $SRC (token without read access to $REPO?)"
	elif curl -fsSL -o "$TGZ" "https://codeload.github.com/$REPO/tar.gz/$REF" 2>/dev/null; then :
	elif have gh && gh auth status >/dev/null 2>&1; then
		gh api "repos/$REPO/tarball/$REF" >"$TGZ" || die "gh could not download $SRC"
	else
		die "cannot download $SRC: the repo is private or the ref does not exist. Sign in with 'gh auth login' or set GITHUB_TOKEN, or point DOTZ_TARBALL at a tarball"
	fi
fi
mkdir "$TMP/x"
tar -xzf "$TGZ" -C "$TMP/x" || die "not a .tar.gz: $SRC"
# GitHub tarballs (and git archive --prefix) wrap everything in one top folder.
TOP=$TMP/x
set -- "$TMP"/x/*
[ $# -eq 1 ] && [ -d "$1" ] && TOP=$1
[ -f "$TOP/setup.ts" ] && [ -f "$TOP/hub/main.ts" ] || die "$SRC does not look like dotz (no setup.ts / hub/main.ts)"

UPGRADE=
[ -d "$APP" ] && UPGRADE=1
mkdir -p "$(dirname "$APP")"
rm -rf "$APP.new" "$APP.old"
mv "$TOP" "$APP.new"
[ -n "$UPGRADE" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$APP.old"
printf 'source=%s\ninstalled=%s\n' "$SRC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$APP/.dotz-install"
say "$([ -n "$UPGRADE" ] && echo upgraded || echo installed) $SRC -> $APP"

# 4. deps (dotz itself has none today; this keeps a future package.json working)
(cd "$APP" && bun install --production >/dev/null 2>&1) || die "bun install failed in $APP"

# 5. data dir: only the folder; setup.ts writes config.json and the gateway its templates on first start.
mkdir -p "$DATA"
chmod 700 "$DATA"

# 6. wizard
if [ "$SETUP" = auto ]; then
	if [ -f "$DATA/config.json" ]; then SETUP=no; else SETUP=yes; fi
fi
if [ "$SETUP" = no ]; then
	[ -n "$UPGRADE" ] && svc_restart
	say "done. Wizard again: bun $APP/setup.ts"
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
