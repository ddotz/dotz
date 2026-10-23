// One-time setup steps a new version needs, run by the gateway itself at start so an update never leaves the owner's bot with commands to run.
// Each migration has an id and runs once per install (<data dir>/migrations.json). It is idempotent, adds or asks and never deletes user data.
// Returns a short Korean summary when it changed something (undefined = nothing to do). A failure leaves one Korean notice and is retried at the
// next start. The commands the migrations replace (features/*/bin/onboard.ts) stay for manual use.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findLegacy, LEGACY_NO, LEGACY_YES, legacyGate } from "../features/youtube-instagram/lib/legacy.ts";
import { createApp } from "./app-off.ts";
import { issueBlock } from "./choices.ts";
import { commentsDir, createStore } from "./comments/store.ts";
import { log as hubLog, writeAtomic } from "./config.ts";
import { APPS_FILE, srcKey } from "./integrations.ts";

export const MIGRATIONS_FILE = "migrations.json";
export const LEGACY_ID = "legacy-sns-tokens";

type State = { done: Record<string, { at: string; note?: string }>; pending: Record<string, string[]> };
export type Ctx = { dataDir: string; state: State; ask: (text: string) => void };
export type Migration = { id: string; label: string; run: (ctx: Ctx) => string | undefined | Promise<string | undefined> };
export type Deps = { dataDir: string; ask: (text: string) => void; notify: (text: string) => void; migrations?: Migration[]; log?: (s: string) => void; now?: () => Date };

const readState = (dataDir: string): State => {
	try {
		const v = JSON.parse(readFileSync(join(dataDir, MIGRATIONS_FILE), "utf8"));
		return { done: v?.done && typeof v.done === "object" ? v.done : {}, pending: v?.pending && typeof v.pending === "object" ? v.pending : {} };
	} catch {
		return { done: {}, pending: {} };
	}
};
const saveState = (dataDir: string, s: State) => writeAtomic(join(dataDir, MIGRATIONS_FILE), `${JSON.stringify(s, null, 1)}\n`);

// (a) Every website comment source with no app instance yet gets one: the same entry `onboard.ts on --app site --name X` makes (id site-X,
// the label he gave the site, filter.source). Existing instances are left alone, so the owner's own renames and deletions of a made one stay.
const siteApps: Migration = {
	id: "site-comment-apps",
	label: "웹사이트 댓글 앱 만들기",
	run: ({ dataDir }) => {
		const sites = Object.values(createStore(commentsDir(dataDir)).config().sources).filter(s => s.kind === "website" && /^site-.+/.test(s.key));
		if (!sites.length) return undefined;
		let doc: Record<string, { app?: string; filter?: { source?: string } }> = {};
		try {
			doc = JSON.parse(readFileSync(join(dataDir, APPS_FILE), "utf8")) ?? {};
		} catch {
			// no apps file yet
		}
		const have = new Set(Object.entries(doc).filter(([, r]) => r?.app === "site" && typeof r.filter?.source === "string").map(([, r]) => srcKey(r.filter!.source!)));
		const made: string[] = [], failed: string[] = [];
		for (const s of sites) {
			const name = s.key.slice(5);
			if (doc[s.key] || have.has(srcKey(name))) continue;
			try {
				createApp(dataDir, { app: "site", id: s.key, label: s.label.slice(0, 30), filter: { source: name } });
				made.push(name);
			} catch (e) {
				failed.push(`${name}: ${(e as Error).message}`);
			}
		}
		if (failed.length) throw new Error(failed.join(", "));
		return made.length ? `웹사이트 댓글 앱 ${made.length}개 만듦 (${made.join(", ")})` : undefined;
	},
};

// (b) The earlier YouTube/Instagram login: never copied silently. One owner question (once), and the answer (legacyAnswer) copies or records the refusal.
export const legacyAsk = (names: string[]): string =>
	`[ask] 예전 유튜브·인스타 연결을 찾았어요. 가져올까요? (${names.join(", ")})\n${issueBlock("예전 유튜브·인스타 연결을 가져올까요?", [
		{ name: "가져오기", result: "예전 설정의 연결 파일을 이 컴퓨터로 복사해요 (권한 0600). 값은 어디에도 보여 주지 않아요." },
		{ name: "안 가져오기", result: "복사하지 않고 다시 묻지 않아요." },
	])}`;
const legacyTokens: Migration = {
	id: LEGACY_ID,
	label: "예전 유튜브·인스타 연결 묻기",
	run: ctx => {
		const names = Object.keys(findLegacy());
		if (!names.length || ctx.state.pending[LEGACY_ID]) return undefined;
		ctx.state.pending[LEGACY_ID] = names;
		ctx.ask(legacyAsk(names));
		return "예전 유튜브·인스타 연결을 가져올지 물었어요";
	},
};

export const MIGRATIONS: Migration[] = [siteApps, legacyTokens];

/** Runs every migration that is not done, in order. One notice line lists what changed; each failure gets its own notice and is retried at the next start. */
export async function runMigrations(deps: Deps): Promise<{ ran: string[]; failed: string[] }> {
	const log = deps.log ?? hubLog;
	const state = readState(deps.dataDir);
	const ran: string[] = [], failed: string[] = [];
	for (const m of deps.migrations ?? MIGRATIONS) {
		if (state.done[m.id]) continue;
		try {
			const note = await m.run({ dataDir: deps.dataDir, state, ask: deps.ask });
			state.done[m.id] = { at: (deps.now?.() ?? new Date()).toISOString(), ...(note ? { note } : {}) };
			saveState(deps.dataDir, state);
			log(`migration ${m.id}: ${note ?? "nothing to do"}`);
			if (note) ran.push(note);
		} catch (e) {
			failed.push(m.id);
			log(`migration ${m.id} failed: ${(e as Error).message}`);
			deps.notify(`업데이트 뒤 설정 "${m.label}"을 마치지 못했어요 (${(e as Error).message.slice(0, 120)}). 게이트웨이를 다시 켤 때 다시 해 봐요.`);
		}
	}
	if (ran.length) deps.notify(`업데이트 뒤 필요한 설정을 자동으로 마쳤어요: ${ran.join(", ")}`);
	return { ran, failed };
}

const YES = /^\s*(?:\*\*)?1\)\s*가져오기/;
const NO = /^\s*(?:\*\*)?2\)\s*안 가져오기/;

/** The owner's answer to the legacy question (a button click or the web card types "1) 가져오기" / "2) 안 가져오기"); read only while that question is open.
 *  Returns the reply to post, or undefined when the text is not an answer to it. */
export function legacyAnswer(dataDir: string, text: string): string | undefined {
	const yes = YES.test(text);
	if (!yes && !NO.test(text)) return undefined;
	if (!existsSync(join(dataDir, MIGRATIONS_FILE))) return undefined;
	const state = readState(dataDir);
	if (!state.pending[LEGACY_ID]) return undefined;
	const g = legacyGate([yes ? LEGACY_YES : LEGACY_NO]);
	delete state.pending[LEGACY_ID];
	saveState(dataDir, state);
	return g.lines.join("\n") || "가져올 연결 파일을 더는 찾지 못했어요. 다시 묻지 않아요.";
}
