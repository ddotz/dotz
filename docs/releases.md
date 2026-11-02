# Releases

A version is `YYMMDD.N`: the KST calendar day, then 1, 2 or 3 for the releases cut inside that day (`261103.1`). `VERSION`
in the repo root holds the version of that commit, and a release is the tag `v<version>` on a commit on `main`.
Commits pushed to `main` reach nobody by themselves; the tag is the only thing installs see, so work piles up and a release
batches it. The updater checks at 12:00, 18:00 and 24:00 KST and moves to the newest tag it finds.
`.github/workflows/release.yml` runs `bun hub/release.ts --auto` in those three windows: with no commit after the newest tag
it prints one line and stops, otherwise it writes `VERSION`, commits, tags and pushes `main` plus the tag. A 24:00 KST cut
falls on the next KST day, so it becomes that day's `.1`.
`N` is the number of versions already tagged that day plus one, so a day whose first release came at 18:00 is `.1`, not `.2`.
A fourth release in one day is refused with the reason; so is a dirty tracked tree and a tag dated after today.
Cut one outside the windows with `bun hub/release.ts` (same rule), or add `--dry-run` to see the version and summary without
writing anything. It never runs tests: the updater side tests what a release contains.
See the current version with `cat VERSION`, and what shipped with `git tag --list 'v*' | tail -3` or
`git ls-remote --tags origin`; `git describe --tags --abbrev=0` names the last release marker.
There is no CHANGELOG: each release commit carries a one-line summary of the changes it batches.
