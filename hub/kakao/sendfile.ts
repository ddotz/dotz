// Files to the owner's own 나와의 채팅 (`cli.ts send-file --self`), by UI automation of the KakaoTalk app only (attach.jxa.js): the self room
// is opened and verified the way a text send opens a room (room.ts openRoom), each file is pasted into it through KakaoTalk's own 붙여넣기
// menu item and its send dialog is pressed. Each file is confirmed from KakaoTalk's database (a new photo / file message of the owner in
// that room) before the next one starts; a file whose press is not confirmed is never pressed again. No Kakao API, HTTP or protocol here.
// Only the self room is ever opened: the caller passes it from the database (type 5), nothing here takes another room, and a doubt refuses:
// a room of the same name in the database, another chat window, a window that does not show it is the 나와의 채팅 (attach.jxa.js selfGate).
// KakaoTalk is never brought to the front, not even for its list window: without the dialog in the background the send fails and says so.
import attachJxa from "./attach.jxa.js" with { type: "text" };
import jxa from "./room.jxa.js" with { type: "text" };
import { closeWindow, normalizeTitle, openRoom, type RoomFact } from "./room.ts";
import type { Msg, Runner } from "./types.ts";

export type FileSendInput = {
	files: string[];
	// The database's 나와의 채팅 (kind "self") with the name KakaoTalk's list shows for it (the owner's own profile name).
	room: RoomFact & { kind: "self" };
	all: RoomFact[];
	// The newest messages of that room, oldest first (cli.ts Reader.messages).
	messages: (limit: number) => Promise<Msg[]>;
};
export type FileSendDeps = { runner: Runner; sleep: (ms: number) => Promise<void>; now: () => number };
// warning: something the owner must know whatever the outcome (the clipboard was not put back).
export type FileSendResult = { ok: boolean; sent: number; reason?: string; warning?: string; steps: string[] };

// One attach is at most two gates, the dialog wait and the close wait (about 17 s); past that the kill leaves the clipboard unrestored.
const ATTACH_MS = 30_000;
const CONFIRM_MS = 20_000;
const POLL_MS = 1_000;
const TEXT_TYPES = new Set([0, 1, 26]);

const newer = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? BigInt(a) > BigInt(b) : a !== b);

type AttachOut = { ok: boolean; why?: string; pressed?: boolean; seen?: string; clipboard?: boolean };
async function attach(runner: Runner, name: string, path: string): Promise<AttachOut> {
	try {
		const r = await runner(["osascript", "-l", "JavaScript", "-e", jxa, "-e", attachJxa], { stdin: `${JSON.stringify({ action: "attach", name, path })}\n`, timeoutMs: ATTACH_MS });
		const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
		const clipboard = out?.clipboard === false ? { clipboard: false } : {};
		if (out?.ok === true) return { ok: true, pressed: true, ...clipboard };
		if (typeof out?.why !== "string") return { ok: false, why: "uncertain", pressed: true, clipboard: false };
		return { ok: false, why: out.why, pressed: out.pressed === true, ...clipboard, ...(typeof out.seen === "string" ? { seen: out.seen } : {}) };
	} catch {
		// No answer that says how far it got: the press may have happened, so the database decides and nothing is pressed again. A killed
		// script never reached its restore, so the clipboard counts as not put back.
		return { ok: false, why: "uncertain", pressed: true, clipboard: false };
	}
}

const CLIPBOARD_LOST = "복사해 둔 클립보드 내용을 되돌리지 못했어요. 필요하면 다시 복사해 주세요";

const WHY: Record<string, string> = {
	no_window: "나와의 채팅 창을 찾지 못했어요",
	no_input: "나와의 채팅 창에서 입력창을 찾지 못했어요",
	owner_text: "나와의 채팅 입력창에 보내지 않은 글이 있어서 보내지 않았어요. 그 글은 지우지 않았어요",
	no_paste_item: "카카오톡 편집 메뉴에서 붙여넣기를 찾지 못했어요",
	pasteboard: "파일을 클립보드에 올리지 못했어요",
	pasted_text: "카카오톡이 파일 대신 글로 붙여 넣어서 지우고 보내지 않았어요",
	no_dialog: "카카오톡이 뒤에 있는 상태에서 파일 전송 창이 뜨지 않았어요. 앞으로 가져오지 않고 멈췄어요",
	other_window: "다른 카카오톡 채팅창이 열려 있어서 보내지 않았어요. 그 창을 닫고 다시 보내 주세요",
	not_self: "열린 창이 나와의 채팅인지 확인하지 못해서 보내지 않았어요",
	dialog_left: "보내지 않았지만 파일 전송 창을 닫지 못했어요. 카카오톡에서 취소해 주세요",
};

const lastLogId = (list: Msg[]) => list.at(-1)?.logId ?? "0";

// A new message of the owner in the room after `after` that is not text: the file or photo that was just sent.
async function arrived(input: FileSendInput, after: string, deps: FileSendDeps): Promise<boolean> {
	const end = deps.now() + CONFIRM_MS;
	for (;;) {
		try {
			if ((await input.messages(20)).some(m => m.fromMe && !TEXT_TYPES.has(m.type) && newer(m.logId, after))) return true;
		} catch {
			// A busy database: the next poll reads again, and the deadline ends it as not confirmed.
		}
		if (deps.now() >= end) return false;
		await deps.sleep(POLL_MS);
	}
}

export async function sendFilesToSelf(input: FileSendInput, deps: FileSendDeps): Promise<FileSendResult> {
	const steps: string[] = [];
	let clipboardLost = false;
	const warned = () => (clipboardLost ? { warning: CLIPBOARD_LOST } : {});
	const fail = (sent: number, reason: string): FileSendResult => ({ ok: false, sent, reason, steps, ...warned() });
	if (input.room.kind !== "self") return fail(0, "나와의 채팅에만 파일을 보낼 수 있어요");
	const want = normalizeTitle(input.room.name);
	if (input.all.some(r => r.chatId !== input.room.chatId && normalizeTitle(r.name) === want)) return fail(0, "나와의 채팅과 이름이 같은 방이 있어서 보내지 않았어요");
	const hint = input.all.findIndex(r => r.chatId === input.room.chatId);
	let sent = 0;
	// The owner's own window (open before this send) and their unsent text in it stay as they were.
	let keepWindow = false;
	try {
		for (const [i, path] of input.files.entries()) {
			let after: string;
			try {
				after = lastLogId(await input.messages(1));
			} catch {
				return fail(sent, "나와의 채팅을 읽지 못해서 보내지 않았어요");
			}
			const opened = await openRoom(input.room, input.all, deps.runner, { stayBehind: true, ...(hint >= 0 ? { hint } : {}) });
			steps.push(`open:${opened.ok}:${opened.steps.map(s => `${s.step}=${s.ok}`).join(",")}`);
			if (!opened.ok) return fail(sent, opened.reason);
			if (i === 0 && opened.steps.some(s => s.why === "already_open")) keepWindow = true;
			const r = await attach(deps.runner, input.room.name, path);
			steps.push(`attach:${r.ok ? "ok" : r.why}${r.seen ? `:${r.seen}` : ""}`);
			if (r.clipboard === false) clipboardLost = true;
			if (r.why === "owner_text") keepWindow = true;
			if (!r.ok && !r.pressed) return fail(sent, WHY[r.why ?? ""] ?? "카카오톡에 파일을 넣지 못했어요");
			if (!(await arrived(input, after, deps))) return fail(sent, "나와의 채팅에 파일이 들어왔는지 확인하지 못했어요. 다시 보내지 않았으니 카카오톡에서 확인해 주세요");
			sent++;
		}
		return { ok: true, sent, steps, ...warned() };
	} finally {
		if (!keepWindow) await closeWindow(deps.runner, input.room.name);
	}
}
