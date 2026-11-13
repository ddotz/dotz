// Every reason a reply send or action can end with (the reply unification design, section 2): its class (surely not sent, may have gone
// out, or not a send failure), its plain Korean and English text, what code may retry by itself (section 2.4) and the buttons the owner gets.
// The text is the cause only; a card builds its line around it. Raw tool output never comes here: it goes to hub.log.
import type { OwnerAction, Reason, ReasonCode } from "./reply-types.ts";

/** `no`: surely not sent. `maybe`: may have gone out (확인 필요; code never sends it again). `action`: an action was refused or a revise failed. */
export type ReasonClass = "no" | "maybe" | "action";
/** Code's own retry of a `failed` send: `repair` runs the adapter's repair first; `waits[i]` is the wait in ms before attempt i + 1. */
export type AutoPolicy = { max: number; waits: number[]; repair?: true };
export type ReasonPolicy = { class: ReasonClass; auto?: AutoPolicy; actions: OwnerAction[] };
type Entry = ReasonPolicy & { ko: string; en: string };

const S = 1000, M = 60 * S;
const auto = (max: number, waits: number[], repair?: true): AutoPolicy => ({ max, waits, ...(repair ? { repair } : {}) });
const no = (ko: string, en: string, actions: OwnerAction[], a?: AutoPolicy): Entry => ({ class: "no", ko, en, actions, ...(a ? { auto: a } : {}) });
// Every may-have-gone-out reason offers the same three: 나갔어요, 확인하러 가기, 다시 보내기 (as the owner's own decision).
const maybe = (ko: string, en: string): Entry => ({ class: "maybe", ko, en, actions: ["resolve_sent", "open_channel", "resolve_retry"] });
const refused = (ko: string, en: string): Entry => ({ class: "action", ko, en, actions: [] });

const TABLE: Record<ReasonCode, Entry> = {
	login_expired: no("{app} 로그인이 풀렸어요", "You were signed out of {app}", ["relogin", "retry"], auto(3, [0, 0, 0], true)),
	offline: no("인터넷에 연결되지 않았어요", "There is no internet connection", ["retry"], auto(3, [30 * S, 2 * M, 10 * M])),
	rate_limited: no("{app}에서 잠시 뒤에 다시 하라고 했어요", "{app} asked to try again a little later", ["retry"], auto(3, [M, 5 * M, 15 * M])),
	quota: no("오늘 {app} 사용 한도를 다 썼어요", "Today's {app} quota is used up", ["retry"]),
	rejected: no("{app}에서 이 글을 받지 않았어요", "{app} did not accept this text", ["retry", "drop"]),
	recipient_invalid: no("받는 주소가 올바르지 않아요", "The recipient address is not valid", ["fix_recipient"]),
	recipient_not_on_mail: no("받는이에 원래 메일에 없던 주소가 있어요 ({address})", "A recipient was not on the original mail ({address})", ["fix_recipient"]),
	recipient_self: no("받는이가 내 주소예요 ({address})", "A recipient is your own address ({address})", ["fix_recipient"]),
	recipient_missing: no("받는 사람이 없어요", "There is no recipient", ["fix_recipient"]),
	subject_re: no("제목이 답장 형식(Re:)이 아니에요", "The subject is not a reply subject (Re:)", ["retry"], auto(1, [0], true)),
	placeholder: no("채우지 않은 자리가 글에 남아 있어요 (예: [이름])", "The text still has a blank to fill in (like [name])", []),
	forbidden_word: no("쓰지 않기로 한 표현이 들어 있어요 ('{word}')", "The text has a phrase you chose not to use ('{word}')", []),
	too_long: no("글이 너무 길어요 ({n}자, {max}자까지)", "The text is too long ({n} characters, up to {max})", []),
	empty: no("보낼 글이 비어 있어요", "There is no text to send", []),
	attach_mismatch: no("첨부가 글과 맞지 않아요 ({issues})", "The attachments do not match the text ({issues})", ["pick_file"]),
	attach_missing: no("첨부 파일 '{name}'를 찾지 못했어요", "The attachment '{name}' was not found", ["pick_file"]),
	attach_upload: no("첨부 파일을 올리지 못했어요", "The attachment could not be uploaded", ["retry"], auto(1, [30 * S])),
	file_pending: no("첨부 파일을 아직 내려받는 중이에요", "The attachment is still downloading", ["retry"], auto(5, [M, M, M, M, M])),
	cannot_attach: no("이 메일은 파일을 붙여 보낼 수 없어요", "This mail cannot carry attachments", ["pick_file"]),
	account_needed: no("어느 메일 계정으로 보낼지 정해지지 않았어요", "No mail account is chosen to send from", ["pick_account"]),
	webmail_recipients: no("이 웹메일은 받는 사람 한 명에게만 보낼 수 있어요", "This webmail can send to one recipient only", ["fix_recipient"]),
	manual_only: no("이 메일은 여기서 보낼 수 없어서 직접 보내야 해요", "This mail cannot be sent from here; send it yourself", ["drop"]),
	mail_gone: no("함께 보낼 메일 초안이 없어졌어요", "The mail draft that goes with it is gone", []),
	stale: no("그사이 새 메시지가 와서 이 초안은 낡았어요", "A new message came in, so this draft is out of date", ["redraft", "drop"]),
	gone: no("이미 처리됐거나 없는 초안이에요", "This draft is already handled or does not exist", []),
	original_gone: no("원래 글이 지워졌어요", "The original post was deleted", ["drop"]),
	app_off: no("{app} 연동이 꺼져 있어요", "The {app} connection is off", ["open_channel"]),
	lease_held: no("{pc}에서 이 대화방으로 보내는 중이에요", "{pc} is sending to this chat right now", ["retry"], auto(3, [M, M, M])),
	lease_unknown: no("다른 컴퓨터와 겹치지 않는지 확인하지 못했어요", "Could not check that no other computer is sending", ["retry"], auto(2, [30 * S, 30 * S])),
	app_not_ready: no("카카오톡 창을 준비하지 못했어요", "The KakaoTalk window could not be made ready", ["retry"], auto(2, [M, M], true)),
	input_busy: no("카카오톡 입력창에 쓰던 글이 있어요", "The KakaoTalk input box has text you were writing", ["open_channel", "retry"]),
	room_unknown: no("대화방을 찾지 못했어요", "The chat room was not found", ["drop"]),
	not_approved: no("보내기로 고른 기록이 없어요", "There is no record that you chose to send this", []),
	tool_before_send: no("보내기 전 준비 단계에서 오류가 났어요", "Something failed while getting ready to send", ["retry"], auto(1, [30 * S])),
	config: no("{app} 보내기 설정이 올바르지 않아요", "The {app} send settings are not valid", ["open_channel"]),

	net_cut: maybe("보내는 중에 연결이 끊겼어요", "The connection dropped while sending"),
	timeout: maybe("보내는 데 너무 오래 걸려서 멈췄어요", "Sending took too long and was stopped"),
	interrupted: maybe("보내는 중에 dotz가 다시 시작됐어요", "dotz restarted while sending"),
	server_error: maybe("{app}에서 오류로 답했어요", "{app} answered with an error"),
	press_unconfirmed: maybe("전송 버튼은 눌렀는데 보내진 걸 확인하지 못했어요", "The send button was pressed but the message could not be confirmed"),
	readback_mismatch: maybe("보냈다는 답은 왔는데 쪽지함에서 보이지 않아요", "The send was accepted but it does not show in the messages"),
	state_write: maybe("보낸 기록을 남기지 못했어요", "The record of the send could not be saved"),
	unknown: maybe("보내다가 문제가 생겼어요", "Something went wrong while sending"),

	already_sending: refused("이미 보내는 중이에요", "It is already being sent"),
	already_sent: refused("이미 보낸 답장이에요", "This reply was already sent"),
	not_pending: refused("이미 처리됐거나 없는 초안이에요", "This draft is already handled or does not exist"),
	needs_resolve: refused("나갔는지 먼저 확인해 주세요. 나갔어요나 다시 보내기를 골라 주세요", "Check first whether it went out: choose Sent or Send again"),
	revising: refused("지금 고치는 중이에요", "It is being revised right now"),
	not_supported: refused("이 카드에서는 할 수 없어요", "This card cannot do that"),
	owner_only: refused("사용자가 직접 눌러야 하는 일이에요", "Only the owner can do this"),
	revise_failed: refused("고친 초안을 만들지 못했어요", "The revised draft could not be made"),
	revise_limit: refused("{text}", "{text}"),
};

export const REASON_CODES = Object.keys(TABLE) as ReasonCode[];
export const isReasonCode = (s: unknown): s is ReasonCode => typeof s === "string" && Object.hasOwn(TABLE, s);

/** The class, the automatic retry (absent: never by code) and the owner's buttons of `code`. */
export function policyOf(code: ReasonCode): ReasonPolicy {
	const { class: c, auto: a, actions } = TABLE[code];
	return { class: c, actions, ...(a ? { auto: a } : {}) };
}

// A value the caller did not give: the app and the computer get a plain word, any other one drops with the "( ... )" or '...' around it.
const FALLBACK: Record<"ko" | "en", Record<string, string>> = { ko: { app: "앱", pc: "다른 컴퓨터", text: "모델 사용 한도에 닿아서 고치지 못했어요" }, en: { app: "the app", pc: "Another computer", text: "The model usage limit was reached, so it was not revised" } };
function fill(t: string, vars: Record<string, string | number>, lang: "ko" | "en"): string {
	const val = (k: string) => (vars[k] !== undefined && String(vars[k]) !== "" ? String(vars[k]) : FALLBACK[lang][k]);
	return t
		.replace(/\s*\([^()]*\{(\w+)\}[^()]*\)|\s*'\{(\w+)\}'/g, (m, a?: string, b?: string) => (val((a ?? b)!) === undefined ? "" : m))
		.replace(/\{(\w+)\}/g, (_m, k: string) => val(k) ?? "");
}

/** The plain line of `code` with its values filled in (Korean by default; the hub's own texts are Korean). */
export function reasonOf(code: ReasonCode, vars: Record<string, string | number> = {}, lang: "ko" | "en" = "ko"): Reason {
	return { code, text: fill(TABLE[code][lang], vars, lang) };
}

/** Some parts went out and one did not: the count, then the cause of the failing part (its code is the reason's). */
export function partialReason(p: { done: number; total: number; code: ReasonCode; vars?: Record<string, string | number> }, lang: "ko" | "en" = "ko"): Reason {
	const head = lang === "ko" ? `${p.total}개 중 ${p.done}개만 보냈어요` : `Only ${p.done} of ${p.total} parts were sent`;
	return { code: p.code, text: `${head}. ${reasonOf(p.code, p.vars, lang).text}` };
}
