# Releases

A version is `YYMMDD.N`: the KST calendar day, then 1, 2 or 3 for the scheduled releases cut inside that day (`261103.1`).
`VERSION` in the repo root holds the version of that commit, and a release is the tag `v<version>` on a commit on `main`.
Commits pushed to `main` reach nobody by themselves; the tag is the only thing installs see, so work piles up and a release
batches it. The updater checks at 12:00, 18:00 and 24:00 KST and moves to the newest tag it finds.
`.github/workflows/release.yml` runs `bun hub/release.ts --auto` in those three windows: with no commit after the newest tag
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
See the current version with `cat VERSION`, and what shipped with `git tag --list 'v*' | tail -3` or
`git ls-remote --tags origin`; `git describe --tags --abbrev=0` names the last release marker.
