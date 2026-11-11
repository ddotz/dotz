// The exit code of a release-slot tick whose slot was skipped (the suite was red, or it was green and the release failed). The watch reads it:
// the same skipped slot fails every minute, and its alert must say "slot skipped", not count those minutes as failures.
// Its own file: hub/release.ts must not load hub/config.ts and the watch text must not load hub/release.ts.
export const SLOT_SKIPPED_EXIT = 3;
