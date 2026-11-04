// What runs once on load: stored notices re-read with the current rules. A part of the notice store split out of hub/notices.ts, code unchanged.
import { existsSync, readFileSync } from "node:fs";
import { log, now, paths } from "./config.ts";
import { refreshDraft } from "./draft-approval.ts";
import { retireStoredAsks } from "./asks.ts";
import type { HubEvent } from "./events.ts";
import type { Notice } from "./notices-types.ts";
import { stampApp } from "./notices-wiring.ts";
import { noteLaunch, recordedTitle } from "./notices-lanes.ts";
import { items, pruneWatch, save } from "./notices-store.ts";

// Notices stored before the project name left the screen keep their old title; they read with the current one (owner 2026-10-29).
for (const n of items) if (n.key === "self-update" && n.title === "dotz 새 버전") n.title = "새 버전";
// Every stored send-approval card is re-read with the current rules on start, so a fix to how drafts are shown reaches the cards made
// before it (owner 2026-10-26). Silent: nothing is posted or asked; only the stored card changes. Returns how many changed.
export function refreshNoticeDrafts(list: Notice[]): number {
	let n = 0;
	for (const it of list) {
		const d = it.decision?.draft;
		if (!d) continue;
		const r = refreshDraft(d, it.text);
		const retitled = it.decision!.state === "open" && retitleDraftCard(it);
		if (!retitled && JSON.stringify(r) === JSON.stringify(d)) continue;
		it.decision!.draft = r;
		n++;
	}
	return n;
}
// The question's trailing "(<ref>)" is what a 보내기 pick records and what the send gate looks for (draftVerdict matches the draft's own id), so it
// follows the draft: a bot's `mail:<id>` card rewritten to the app draft of that mail otherwise refuses every 보내기 as "not approved".
export function retitleDraftCard(n: Notice): boolean {
	const ref = n.decision?.draft?.ref, tag = /\(([^()]*)\)\s*$/.exec(n.title);
	if (!ref || !tag || tag[1] === ref) return false;
	n.title = `${n.title.slice(0, tag.index)}(${ref})`;
	return true;
}
{
	const n = refreshNoticeDrafts(items);
	if (n) {
		save();
		log(`notices: ${n} draft card(s) re-read with the current rules`);
	}
	if (retireStoredAsks(items, now())) save();
}
if (pruneWatch()) save();

// Watch reports stored before the resolver was set (or before the notice carried `app`) get their app now, once at start: the file keeps it from then on.
export function tagStoredApps(): number {
	const changed = items.filter(i => i.kind === "watch" && stampApp(i)).length;
	if (changed) save();
	return changed;
}
// On load: items that were stored as "세션" (the title was not known when they were made) get their lane's real title when one
// can be found, without touching anything else.
function retitleStored(): void {
	if (!items.some(i => i.key?.startsWith("lane:") && i.title === "세션")) return;
	if (existsSync(paths.outbox))
		for (const line of readFileSync(paths.outbox, "utf8").split("\n"))
			if (line.includes('"lane_start"') && line.includes('"title"'))
				try {
					const e = JSON.parse(line) as HubEvent;
					if (e.kind === "lane_start") noteLaunch(e);
				} catch {
					continue;
				}
	let changed = 0;
	for (const i of items) {
		if (!i.key?.startsWith("lane:") || i.title !== "세션") continue;
		const title = recordedTitle(i.key.slice(5));
		if (title) {
			i.title = title;
			changed++;
		}
	}
	if (changed) {
		save();
		log(`notices retitled: ${changed} lane items`);
	}
}
retitleStored();
