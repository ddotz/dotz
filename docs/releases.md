# Releases

A version is `YYMMDD.N`: the KST calendar day, then 1, 2 or 3 for the scheduled releases cut inside that day (`261103.1`).
`VERSION` in the repo root holds the version of that commit, and a release is the tag `v<version>` on a commit on `main`.
Commits pushed to `main` reach nobody by themselves; the tag is the only thing installs see, so work piles up and a release
batches it. Releases are cut at 12:00, 18:00 and 24:00 KST; each install's updater checks every 10 minutes and moves to the
newest tag it finds. The owner's machine cuts the release itself in those three windows (below) with `bun hub/release.ts --auto --sha <tested commit>`: with no commit after the newest tag
it prints one line and stops, otherwise it rebuilds the public demo (`bun site/build-demo.ts`; a failed build is logged and the release goes out without the demo update), writes `VERSION`, commits both together, makes a signed tag and pushes `main` plus the tag.
Every release tag is an SSH-signed annotated tag (Signed tags, below); a machine without the signing key releases nothing. A 24:00 KST cut
falls on the next KST day, so it becomes that day's `.1`.
`N` is the number of scheduled versions already tagged that day plus one, so a day whose first release came at 18:00 is
`.1`, not `.2`. A fourth scheduled release in one day is refused with the reason; so is a dirty tracked tree and a tag dated
after today.
A forced release (hotfix) appends `.M` instead of taking a window: `bun hub/release.ts --force` cuts the newest version plus
`.1`, `.2`, ... (`261103.1` → `261103.1.1`, `261103.2` → `261103.2.1`). It never creates a `.N`, needs no window, and does
not count against the three scheduled releases of the day. Installations pick a hotfix up at the next window like any other
version; nothing reaches them sooner.
Cut a scheduled release outside the windows with `bun hub/release.ts` (same rule and cap), or add `--dry-run` to see the
version, summary and release note without writing anything. The command itself never runs tests: the full suite runs in the slot watch before the workflow starts (below).

GitHub delayed scheduled runs and sometimes dropped them (the 12:00 slot of 2026-11-04 never ran; others came up to 6 hours late), a
runner there never ran the suite, and a runner cannot hold the signing key (a repo secret leaks with the account), so the owner's machine runs each slot itself. A dotz watch on that machine, `bun hub/release.ts --dispatch` every minute, gates and releases once per slot. Without the key at `<DOTZ_DIR>/secrets/release-signing-key` the tick fails with that reason before it starts the suite. The watch kills a tick
after its timeout (120 s by default) and the suite takes minutes, so the gate runs across ticks and each tick only reads files (a few seconds):
at a new slot the tick starts the gate detached (its own process group, output in `gate.log` in the watch's state dir, its pid in `gate-run.json`)
and ends. The detached run keeps its own clone of `https://github.com/ddotz/dotz.git` in the state dir (the install that runs the watch is usually
a tarball with no `.git`), fetches `origin main` and the tags into it, writes a `nothing` result without running the suite when main has no commit after the newest release tag (the rule `--auto` uses for "nothing to release"; the tick then logs one line and uses the slot, no alert), otherwise makes a worktree of the fetched commit, runs `bun install --frozen-lockfile` and the
full `bun run test` there (through the heavy slot like any full run, about 5 minutes of CPU), removes the worktree and writes `gate-result.json`.
A full run that fails is read from its junit report (`.dotz-last-test.xml`); when the failing files are at most 15% of all test files in that report, only those files run once more in one sequential `bun test` process, and the slot is green if they all pass (those files go into `gate-result.json` as `flaky`, into `gate.log`, one `hub.log` line and, once the release went out, one line of the tick's output with the count and up to 5 names); a larger share or a failing retry is red as before, and there is never a second retry.
Green: before removing the worktree the same detached run releases from it (its dependencies are installed, so the demo build works):
`--auto --sha` releases exactly that commit plus `VERSION` (main is merged into the result afterwards when it moved on, so the tag stays an ancestor
of main and holds no untested commit), signs the tag, pushes `main` and the tag (through `gh auth git-credential`) and creates the GitHub Release, and writes how that went into
`gate-result.json`. The next ticks: still running, nothing to do. Green and released: the slot is used. Green but the release failed: the same as red below, with the release's last lines. Red: nothing is released, the slot counts as skipped, and the watch fails with a line naming the failing files
until the next slot, which is how the owner hears of it; the next slot tests the new head. A gate that cannot run (no fetch, no worktree, no
install, a dead process with no result, or a run older than 45 minutes) is cleaned up and fails the tick without using the slot, so the next tick
starts it again. A new slot stops a run still going from the old one before it starts its own. With the machine off no slot is released. It is a watch, not gateway code: no restart, no model,
and it exists only in the owner's `~/.dotz/watches.json`. The command also refuses any GitHub login except `ddotz`, so a copied watch does nothing.
Add it from the install folder, which follows the tags: `dotz_watch` name `release-slot`, every 1 minute, on `fail`, command
`PATH=/opt/homebrew/bin:$PATH bun ~/.local/share/dotz/hub/release.ts --dispatch`; the default timeout is enough.
A release that failed makes the watch fail until the next slot, so its failure alert tells the owner the window's fixes did not go out. A skipped slot (red suite, or a green one whose release failed) ends the tick with exit 3 (`hub/release-exit.ts`); the watch alert then says the slot was skipped instead of counting the minutes it kept failing.
One slot publishes once: `--auto` stops when the newest scheduled tag's commit is at or after the slot start (00:00, 12:00 or
18:00 KST), so a second run in the same slot does nothing.
`.github/workflows/release.yml` is kept for one thing only, the switch to signed tags: the release that brings this code is started the old way by
the owner's machine before its install has the new code, and inside Actions `release.ts` may tag without a signature only while no signed release tag
exists. From the first signed release on, a run of `release.yml` (by hand or by anyone holding the account) has no key and releases nothing, and a tag
pushed some other way is unsigned, which installs report and, under `enforce`, refuse. A hand-cut scheduled release takes its slot the same way; a forced `.M` does not.

A rewrite of public history is the one case that moves commits under the tags, and the updater only trusts it through a marker: tag
`history-rewrite-<n>` on a blob listing a hash of every old commit (`hub/history-rewrite.ts`), pushed in the same atomic force push as
`main` and the tags. An install whose HEAD holds any listed commit moves at its next 10-minute check, even at the same version: commits
not on the list are saved to `dotz-local/<stamp>` first, re-applied on the new history when they still apply and pass the tests, and
the usual gate and rollback run. It lands on the newest release tag, like any update. Without the marker a divergence is left alone.
The `pre-push` and `pre-rebase` hooks refuse old commits once the marker exists, so a stale checkout cannot put them back on GitHub.
This code only reaches an install through a release, so ship it and let installs take it before any rewrite: an older install stays on
the old history at the same version until the next release, then treats the whole old history as local commits.

Every release is also a GitHub Release whose body is the note `hub/release-note.ts` builds from the commits since the previous tag, with
no model call. It reads like a patch note: each commit is one line under a plain Korean topic (by the files it touches), its subject then
the first sentence of its `왜:` (or else `어떻게:`) with the label dropped (in a body a label counts only at the start of a line), and the rest of the body is not used. A reason that quotes,
names a file, runs past 160 characters or retells the conversation behind the change is skipped: who asked (how the owner is
addressed, from `identity.address` in this install's config, 오너, 사용자가 … 요청했다) or what was wished or settled in chat (~싶어 했다, ~기로 했다,
요청으로, 말한 대로). An aside in brackets that names code (a file, a CSS selector, custom property or
flag, a camelCase or snake_case name, a call, a path) goes whole, in the subject too, and a reason with a code name woven into the sentence is
skipped, so the line is the subject alone. Release and merge commits are left out, and test-only commits and subjects starting `내부 정리:` collapse into one closing count.
The note goes through
`hub/public-scrub.ts`, the same scrub as GitHub posts: the pattern list, this machine's config and secrets when it has a data folder, and
the `PRIVACY_TERMS` repo secret (one term per line) in Actions, where no data folder exists. It covers `<previous tag>..<tag>`, so commits
that landed while the run rebased are in it. `--dry-run` prints it (also on a day that is full), `--force` publishes it the same way, and a Release that fails turns
the run red with the note in its log: the tag is out, so create the Release by hand with `gh release create <tag> --notes-file <file>`.
Tags from before this change have no Release. The update notice and settings → 업데이트 link to the note of the version on offer.

## Signed tags

The key: an ed25519 SSH key at `<DOTZ_DIR>/secrets/release-signing-key` (0600, no passphrase) on the owner's machine only, never in the repo,
in Actions or in a repo secret. Its public half is in `release-signers` at the repo root (OpenSSH allowed signers, one key per line, principal
`dotz-release`, namespace `git`) and in `install.sh`. `hub/release-sign.ts` makes the tag: `git tag -s` with `gpg.format=ssh`, tagger and release
commit always `dotz-release <dotz-release@users.noreply.github.com>`, then checks it against `release-signers` before anything is pushed. A hand-cut
release, `--force` and the `history-rewrite-<n>` marker (`bun hub/history-rewrite.ts --mark <n> < shas`) are signed the same way; `--dry-run` says
whether the key is there and exits 1 when it is not.

The check (`hub/release-verify.ts`) needs no git, only `ssh-keygen` (OpenSSH 8.2 or later; macOS has it, a minimal Linux needs openssh-client).
It always uses the `release-signers` of the version installed now, never the file the new version carries, so a release that brings its own key is
still checked against the old one. A git install reads the fetched tag object (`git cat-file tag`); a tarball install reads it from the GitHub API
(`git/ref/tags/<tag>`, then `git/tags/<sha>`: the exact signed bytes in `verification.payload` and the signature; GitHub's own `verified` is not used)
and downloads the tarball of the commit the signed tag names, not of the tag name. The signed text must name the same tag and that commit, so an old
signed tag pushed again under a newer name is refused. Results: `verified` (with the signer), `unsigned` (a lightweight tag or no signature), `bad`
(another key, or the text was changed), `mismatch` (other tag name or commit), `unverifiable` (no `ssh-keygen`, no `release-signers`, the tag object
could not be read). Each check leaves `signature: <tag> signer=<name> result=<status> (<reason>)` in the update log and a `signature` field in the
check result (`/api/update`, `/api/update/check`, `bun hub/selfupdate.ts --check`).

`self_update.signatures` in `config.json` picks what a result other than `verified` does: `warn` (the default) applies the update anyway, and
`enforce` refuses it and keeps the old code. Either way the owner gets one notice per tag ("서명을 확인하지 못했어요" and the reason). `install.sh`
checks the tag it installs with the key written into it, warns when it cannot (`DOTZ_VERIFY=enforce` stops instead) and warns when `DOTZ_REF`
picks a branch, a commit or an unsigned tag.

Rotating the key: make the new key, add its line to `release-signers` and `install.sh` (keep the old line) and let a release signed with the old key
carry it. Once installs have that version, sign with the new key; a later release drops the old line. Losing the key: no release can be signed
for the current installs. Make a new key, put its public half in `release-signers` and `install.sh`, and release. Under `warn` installs report the
release as `bad` and take it, which also brings the new key; under `enforce` they refuse it and each install has to run `install.sh` again. Keep an
offline copy of the key before switching the default to `enforce`.

See the current version with `cat VERSION`, and what shipped with `git tag --list 'v*' | tail -3` or
`git ls-remote --tags origin`; `git describe --tags --abbrev=0` names the last release marker.
