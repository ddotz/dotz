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
version and summary without writing anything. It never runs tests: the updater side tests what a release contains.

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

See the current version with `cat VERSION`, and what shipped with `git tag --list 'v*' | tail -3` or
`git ls-remote --tags origin`; `git describe --tags --abbrev=0` names the last release marker.
