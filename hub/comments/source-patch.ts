// What the owner can change on a source (engine.ts update, the web's PUT): the followed posts, the auto-draft and auto-send switches, the linked mail and its fixed texts.
import type { SourceConfig, SourceTemplate } from "./contract.ts";
import { withTemplate } from "./template.ts";

export type SourcePatch = { watch?: string[]; autoDraft?: boolean; autoSend?: SourceConfig["autoSend"]; autoMail?: boolean; mailApp?: string; template?: SourceTemplate };

export function patchSource(src: SourceConfig, patch: SourcePatch, now: number): SourceConfig {
	const next: SourceConfig = { ...src };
	if (patch.watch) next.watch = [...new Set(patch.watch)];
	if (patch.autoDraft !== undefined) {
		next.autoDraft = patch.autoDraft;
		if (patch.autoDraft) next.autoSince = now;
	}
	if (patch.autoSend) next.autoSend = patch.autoSend;
	if (patch.autoMail !== undefined) next.autoMail = patch.autoMail;
	if (patch.mailApp !== undefined) {
		if (patch.mailApp) next.mailApp = patch.mailApp;
		else delete next.mailApp;
	}
	if (patch.template) {
		const template = withTemplate(src.template, patch.template);
		if (template) next.template = template;
		else delete next.template;
	}
	if (!next.watch.length) next.autoDraft = false;
	return next;
}
