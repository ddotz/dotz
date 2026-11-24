// A notice as the owner reads it, and the frame the pages are sent. A part of the notice store split out of hub/notices.ts, code unchanged.
import { broadcast as broadcastRaw } from "./events.ts";
import { classOfNotice } from "./notice-class.ts";
import { TZ } from "./config.ts";
import { noticeFor, noticeKo } from "./notice.ts";
import { webView } from "./web-i18n.ts";
import { loginBlockedProvider, watchLine, watchReasonKo } from "./watchtext.ts";
import type { Notice } from "./notices-types.ts";
import { laneTitleOf, watchLabelOf } from "./notices-wiring.ts";
import { waitsOf, type Waits } from "./notices-rules.ts";
import { channelTitle, recordedTitle } from "./notices-lanes.ts";
import { worklogKind } from "./worklog-kind.ts";

export const withClass = (n: Notice, shown: Notice = n): Notice & { cls: string; waits?: Waits; login?: string } => {
	const waits = waitsOf(n);
	const login = waits === "login" && n.kind === "alert" ? loginBlockedProvider(n.text) : undefined;
	return { ...shown, cls: classOfNotice(n).cls, ...(waits ? { waits } : {}), ...(login ? { login } : {}), ...(n.kind === "worklog" ? worklogKind({ ...n, update_key: n.key, source: n.by }) : {}) };
};
export const broadcast = (e: Record<string, unknown>): void => broadcastRaw(e.kind === "notice" && e.item && typeof e.item === "object" ? { ...e, item: withClass(e.item as Notice, readable(e.item as Notice)) } : e);
// First three meaningful lines (no blank lines, rules or fences).
export function summary(text: string): string {
	return text
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !/^(?:[-*_=]{3,}|```.*)$/.test(l))
		.slice(0, 3)
		.map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
		.join("\n");
}

type Dep = { read: () => unknown; was: unknown };
let deps: Dep[] | undefined;
const dep = <T>(read: () => T): T => {
	const was = read();
	deps?.push({ read, was });
	return was;
};
const laneName = (name: string): string | undefined => laneTitleOf(name)?.trim() || recordedTitle(name);
// A notice as the owner reads it (the stored one keeps what the bot wrote): everyday Korean, no tool names, commands, ids or paths (hub/notice-ko.ts).
export const say = (s: string): string => noticeKo(s, { lane: name => dep(() => laneName(name)), keepFiles: true });
type Shown = { kind: Notice["kind"]; key: string | undefined; title: string; text: string; evidence: string[] | undefined; draft: boolean; engine: unknown; day: string; deps: Dep[]; outTitle: string; outText: string; outEvidence: string[] | undefined };
const shown = new WeakMap<Notice, Shown>();
let dayOf: Intl.DateTimeFormat | undefined;
const today = (): string => (dayOf ??= new Intl.DateTimeFormat("en-CA", { timeZone: TZ })).format(Date.now());
export function readable(n: Notice): Notice {
	const engine = noticeFor(webView()), day = today(), draft = !!n.decision?.draft, evidence = n.decision?.evidence;
	let c = shown.get(n);
	if (!c || c.kind !== n.kind || c.key !== n.key || c.title !== n.title || c.text !== n.text || c.evidence !== evidence || c.draft !== draft || c.engine !== engine || c.day !== day || c.deps.some(d => d.read() !== d.was)) {
		const seen: Dep[] = [];
		deps = seen;
		try {
			const r = readableStored(n);
			const outTitle = say(r.title), outText = r.decision?.draft ? r.text : say(r.text);
			const said = draft ? undefined : evidence?.map(say);
			const outEvidence = said && evidence && said.some((l, i) => l !== evidence[i]) ? said : undefined;
			c = { kind: n.kind, key: n.key, title: n.title, text: n.text, evidence, draft, engine, day, deps: seen, outTitle, outText, outEvidence };
		} finally {
			deps = undefined;
		}
		shown.set(n, c);
	}
	if (c.outTitle === n.title && c.outText === n.text && !c.outEvidence) return n;
	return { ...n, title: c.outTitle, text: c.outText, ...(n.decision && c.outEvidence ? { decision: { ...n.decision, evidence: c.outEvidence } } : {}) };
}
// A watch notice stored before labels and Korean reasons: its title is the watch name and its text starts with the raw reason.
function readableStored(n: Notice): Notice {
	if (n.kind === "message" && n.key?.startsWith("msg:settings:")) {   // stored before settings conversations had a name: titled "대화"
		const title = dep(() => channelTitle(n.key!.slice(4)));
		return title === n.title ? n : { ...n, title };
	}
	if (n.kind !== "watch") return n;
	const title = dep(() => watchLabelOf(n.title));
	const [first = "", ...rest] = n.text.split("\n");
	const named = title !== n.title && n.text.startsWith(`${n.title}:`) ? `${title}${n.text.slice(n.title.length)}` : n.text;
	const text = watchReasonKo(first) !== first ? watchLine(title, first, rest.join("\n"), { raw: false }) : named;
	return title === n.title && text === n.text ? n : { ...n, title, text };
}
