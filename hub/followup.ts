// 이어서 할 일: a per-app-instance rule (setting `followup`, free text) that says what comes after an approved action of that app
// (a comment reply posted, a mail reply sent, a KakaoTalk message sent). The gateway wakes the orchestrator ONCE per approved action
// with the rule and the item ids; the bot first checks whether the rule applies, and only then drafts the next step (a mail, through
// `hub/mail-cli.ts compose`, which still waits for the owner's 보내기). No rule = nothing happens, no model turn, no file written.
// A refused, dropped or only drafted action never reaches triggerFollowup; a draft made by a follow-up (`origin`) never starts another one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadSettings, writeAtomic } from "../features/reply-drafts/lib/settings.ts";
import { appEntries } from "./integrations.ts";
import { createHub } from "./kakao/hub.ts";
import { instanceOf } from "./reply-model.ts";

export type FollowupKind = "comment" | "mail" | "kakao";
// `key` makes the action unique (a send record id, a draft id, a kakao draft code): the same key wakes the bot once.
export type FollowupInput = { app: string; kind: FollowupKind; key: string; ids: Record<string, string> };
export type FollowupResult = "woke" | "none" | "duplicate";

const FIRED = "followups.json";
const FIRED_MAX = 1000;
const WHAT: Record<FollowupKind, string> = { comment: "댓글 답글을 올렸어요", mail: "메일 답장을 보냈어요", kakao: "카카오톡 메시지를 보냈어요" };
export const MAIL_CLI = join(import.meta.dir, "mail-cli.ts");

let wake: (text: string) => void = () => {};
/** The gateway installs how a follow-up turn reaches the orchestrator (hub/main.ts); until then (and in tests) it is a no-op. */
export const setFollowupWake = (fn: (text: string) => void): void => {
	wake = fn;
};

/** The rule of an app instance, or "" (the 이어서 할 일 setting, hub/app-settings.ts). */
export const followupRule = (app: string): string => loadSettings().followups?.[app] ?? "";

function readFired(file: string): string[] {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** The one turn the orchestrator gets: the rule, the ids, what to do first (check) and how to continue (compose + approval). Never a dump of the item. */
export function followupTurn(rule: string, i: FollowupInput): string {
	const ids = Object.entries(i.ids).map(([k, v]) => `${k}=${v}`).join(" ");
	const origin = i.kind === "comment" && i.ids.comment ? ` --origin comment:${i.ids.comment}` : "";
	return [
		`[followup:${i.app}] ${WHAT[i.kind]} 이어서 할 일이 있는지 한 번만 확인합니다.`,
		`규칙: ${rule}`,
		`항목: ${ids}`,
		"1. 규칙의 조건에 맞는 항목인지 먼저 봅니다. 원문은 위 id로 필요한 만큼만 읽습니다.",
		"2. 맞지 않으면 초안도 질문도 만들지 않고 아무 말 없이 끝냅니다.",
		`3. 맞으면 메일 초안을 만듭니다: bun ${MAIL_CLI} compose --app <메일 앱> --to <주소> --subject <제목> [--attach <경로>]... [--from-library <키워드>]${origin} (본문은 stdin)`,
		"4. 출력된 블록(받는이, 제목, 첨부, 본문, 보내기/고치기/보내지 않기)을 그대로 [ask]로 올립니다. 오너가 보내기를 고르기 전에는 보내지 않습니다.",
		`5. 보내기를 고르면 bun ${MAIL_CLI} send --draft <코드> 로 보냅니다.`,
	].join("\n");
}

/** An approved action just happened in app instance `i.app`: wake the bot once if that instance has a rule. */
export function triggerFollowup(i: FollowupInput): FollowupResult {
	const rule = followupRule(i.app);
	if (!rule) return "none";
	const file = join(dataDir(), FIRED);
	const fired = readFired(file);
	const key = `${i.app}:${i.kind}:${i.key}`;
	if (fired.includes(key)) return "duplicate";
	writeAtomic(file, `${JSON.stringify([...fired, key].slice(-FIRED_MAX))}\n`);
	wake(followupTurn(rule, i));
	return "woke";
}

export type HubLike = { post: (path: string, body?: unknown) => Promise<{ status: number }> };
/** A call from a CLI to the gateway that must not fail the CLI (the send already happened): false when it did not go through. */
export async function notifyGateway(call: { path: string; body: unknown }, hub?: HubLike): Promise<boolean> {
	try {
		return (await (hub ?? createHub(dataDir())).post(call.path, call.body)).status < 300;
	} catch {
		return false;
	}
}

/** The mail app instance that owns the mail `ref` (the gateway's mail key). */
export const mailInstance = (ref: string): string => instanceOf(appEntries(dataDir()), "mail", `mail:${ref}`);

/** What POST /api/followup accepts (the CLIs of mail replies and KakaoTalk call it after a send the owner approved); null when malformed. */
export function parseFollowup(b: unknown): FollowupInput | null {
	const o = b as Record<string, unknown> | null;
	if (!o || typeof o !== "object") return null;
	const kind = o.kind === "comment" || o.kind === "mail" || o.kind === "kakao" ? o.kind : undefined;
	const ids: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.ids && typeof o.ids === "object" ? (o.ids as Record<string, unknown>) : {})) if (/^[a-z]{1,12}$/.test(k) && typeof v === "string" && v.length <= 200 && !/\s/.test(v)) ids[k] = v;
	if (!kind || typeof o.app !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.app) || typeof o.key !== "string" || !o.key || o.key.length > 200) return null;
	return { app: o.app, kind, key: o.key, ids };
}
