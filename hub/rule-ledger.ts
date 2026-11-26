// The hub's one door to the reply-drafts rule ledger (features/reply-drafts/lib/ledger.ts): the settings screen, the update migration and the follow-up rule read and write the
// ledger through here, so the hub keeps one import edge into the feature for it.
export { dataDir, followupText, migrateLedger, moveHandRules, setLines, textsAt, toAskAbout, undoLedger, writeAtomic } from "../features/reply-drafts/lib/settings.ts";
