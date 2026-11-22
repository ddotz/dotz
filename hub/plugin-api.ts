// The supported runtime surface for custom plugins (<DATA_DIR>/custom/plugins, docs/custom-plugins.md): a plugin imports dotz code at runtime
// from this file only; every other hub file is internal and may change in any release. Removing or renaming an export here is a breaking change.
export { isSealed, readSealKey, sealLine } from "./approval-seal.ts";
export { draftActionOf, type DraftVerdict } from "./draft-approval.ts";
