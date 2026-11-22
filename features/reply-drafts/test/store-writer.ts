import { recordCorrection, saveSettings } from "../lib/settings.ts";
import { addDraft, setStatus, type DraftRec } from "../lib/store.ts";

const [what, tag, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
	if (what === "drafts") {
		const id = `${tag}${String(i).padStart(4, "0")}`;
		addDraft({ id, kind: "mail", app: "mail", source: "zele", mailId: id, ref: `${tag}-${i}`, to: "a@example.com", body: "b", status: "pending", created: new Date().toISOString(), changes: [], questions: [], item: { kind: "mail", from: "a@example.com", text: "t" } } as DraftRec);
		setStatus(id, "sent");
	} else if (what === "tone") recordCorrection({ app: "mail" }, `${tag} ${i}`, new Date());
	else saveSettings(tag === "A" ? { model: `m${i}` } : { senders: { only: [`b${i}@example.com`], skip: [] } });
}
