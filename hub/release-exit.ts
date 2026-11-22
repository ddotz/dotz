// The exit code of a release-slot tick whose slot was skipped (the suite was red, or it was green and the release failed). The watch reads it:
// only the tick that found the skipped slot exits with it, and the watch alerts on it at once as "slot skipped", with no recovery note after.
// Its own file: hub/release.ts must not load hub/config.ts and the watch text must not load hub/release.ts.
export const SLOT_SKIPPED_EXIT = 3;
