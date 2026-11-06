# Releases

A version is `YYMMDD.N`: the KST calendar day, then 1, 2 or 3 for the scheduled releases cut inside that day (`261103.1`).
`VERSION` in the repo root holds the version of that commit, and a release is the tag `v<version>` on a commit on `main`.
Commits pushed to `main` reach nobody by themselves; the tag is the only thing installs see, so work piles up and a release
batches it. Releases are cut at 12:00, 18:00 and 24:00 KST; each install's updater checks every 10 minutes and moves to the
newest tag it finds. `.github/workflows/release.yml` runs `bun hub/release.ts --auto` in those three windows: with no commit after the newest tag
it prints one line and stops, otherwise it writes `VERSION`, commits, tags and pushes `main` plus the tag. A 24:00 KST cut
falls on the next KST day, so it becomes that day's `.1`.
`N` is the number of scheduled versions already tagged that day plus one, so a day whose first release came at 18:00 is
`.1`, not `.2`. A fourth scheduled release in one day is refused with the reason; so is a dirty tracked tree and a tag dated
after today.
A forced release (hotfix) appends `.M` instead of taking a window: `bun hub/release.ts --force` cuts the newest version plus
`.1`, `.2`, ... (`261103.1` → `261103.1.1`, `261103.2` → `261103.2.1`). It never creates a `.N`, needs no window, and does
not count against the three scheduled releases of the day. Installations pick a hotfix up at the next window like any other
version; nothing reaches them sooner.
Cut a scheduled release outside the windows with `bun hub/release.ts` (same rule and cap), or add `--dry-run` to see the
version, summary and release note without writing anything. It never runs tests: the updater side tests what a release contains.

GitHub delays scheduled runs and sometimes drops them (the 12:00 slot of 2026-11-04 never ran; others came up to 6 hours late), so
the owner's machine starts each slot itself. A dotz watch on that machine, `bun hub/release.ts --dispatch` every minute, starts
`release.yml` once per slot through `gh workflow run`; the cron stays as the fallback for when the machine is off. It is a watch,
not gateway code: no restart, no model, and it exists only in the owner's `~/.dotz/watches.json`. The command also refuses any GitHub
login except `ddotz`, so a copied watch does nothing. Add it from the install folder, which follows the tags:
`dotz_watch` name `release-slot`, every 1 minute, on `fail`, command
`PATH=/opt/homebrew/bin:$PATH bun ~/.local/share/dotz/hub/release.ts --dispatch`.
One slot publishes once: `--auto` stops when the newest scheduled tag's commit is at or after the slot start (00:00, 12:00 or
18:00 KST), so a cron run that lands hours late does nothing, and the workflow's `release` concurrency group runs both triggers one
at a time. A hand-cut scheduled release takes its slot the same way; a forced `.M` does not.

A rewrite of public history is the one case that moves commits under the tags, and the updater only trusts it through a marker: tag
`history-rewrite-<n>` on a blob listing a hash of every old commit (`hub/history-rewrite.ts`), pushed in the same atomic force push as
`main` and the tags. An install whose HEAD holds any listed commit moves at its next 10-minute check, even at the same version: commits
not on the list are saved to `dotz-local/<stamp>` first, re-applied on the new history when they still apply and pass the tests, and
the usual gate and rollback run. It lands on the newest release tag, like any update. Without the marker a divergence is left alone.
The `pre-push` and `pre-rebase` hooks refuse old commits once the marker exists, so a stale checkout cannot put them back on GitHub.
This code only reaches an install through a release, so ship it and let installs take it before any rewrite: an older install stays on
the old history at the same version until the next release, then treats the whole old history as local commits.

Every release is also a GitHub Release whose body is the note `hub/release-note.ts` builds from the commits since the previous tag, with
no model call. Commits are grouped by plain Korean topic (by the files they touch); release and merge commits are left out and a test-only
commit is one line under 내부 정리. Each other commit gives three lines: 무엇 (the subject), 왜 and 어떻게 (the body lines `왜:` and `어떻게:`,
`CONTRIBUTING.md`). A body without those labels goes under 어떻게, and a missing part says so instead of guessing. The note goes through
`hub/public-scrub.ts`, the same scrub as GitHub posts: the pattern list, this machine's config and secrets when it has a data folder, and
the `PRIVACY_TERMS` repo secret (one term per line) in Actions, where no data folder exists. It covers `<previous tag>..<tag>`, so commits
that landed while the run rebased are in it. `--dry-run` prints it (also on a day that is full), `--force` publishes it the same way, and a Release that fails turns
the run red with the note in its log: the tag is out, so create the Release by hand with `gh release create <tag> --notes-file <file>`.
Tags from before this change have no Release. The update notice and settings → 업데이트 link to the note of the version on offer.

See the current version with `cat VERSION`, and what shipped with `git tag --list 'v*' | tail -3` or
`git ls-remote --tags origin`; `git describe --tags --abbrev=0` names the last release marker.
