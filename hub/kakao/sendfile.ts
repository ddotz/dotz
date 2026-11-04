// Files to the owner's own 나와의 채팅 (`cli.ts send-file --self`), by UI automation of the KakaoTalk app only (room.jxa.js attach): the
// self room is opened and verified the way a text send opens a room (room.ts openRoom), each file is pasted into it through KakaoTalk's own
// 붙여넣기 menu item and its send dialog is pressed. Each file is confirmed from KakaoTalk's database (a new photo / file message of the owner
// in that room) before the next one starts; a file whose press is not confirmed is never pressed again. No Kakao API, HTTP or protocol here.
// Only the self room is ever opened: the caller passes it from the database (type 5) and nothing here takes another room.
import jxa from "./room.jxa.js" with { type: "text" };
import { closeWindow, openRoom, type RoomFact } from "./room.ts";
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
export type FileSendResult = { ok: boolean; sent: number; reason?: string; steps: string[] };

const CONFIRM_MS = 20_000;
const POLL_MS = 1_000;
const TEXT_TYPES = new Set([0, 1, 26]);

const newer = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? BigInt(a) > BigInt(b) : a !== b);

type AttachOut = { ok: boolean; why?: string; pressed?: boolean; seen?: string };
async function attach(runner: Runner, name: string, path: string, front: boolean): Promise<AttachOut> {
	try {
		const r = await runner(["osascript", "-l", "JavaScript", "-e", jxa], { stdin: `${JSON.stringify({ action: "attach", name, path, front })}\n`, timeoutMs: 20_000 });
		const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
		if (out?.ok === true) return { ok: true, pressed: true };
		if (typeof out?.why !== "string") return { ok: false, why: "uncertain", pressed: true };
		return { ok: false, why: out.why, pressed: out.pressed === true, ...(typeof out.seen === "string" ? { seen: out.seen } : {}) };
	} catch {
		// No answer that says how far it got: the press may have happened, so the database decides and nothing is pressed again.
		return { ok: false, why: "uncertain", pressed: true };
	}
}

const WHY: Record<string, string> = {
	no_window: "나와의 채팅 창을 찾지 못했어요",
	no_input: "나와의 채팅 창에서 입력창을 찾지 못했어요",
	owner_text: "나와의 채팅 입력창에 보내지 않은 글이 있어서 보내지 않았어요. 그 글은 지우지 않았어요",
	no_paste_item: "카카오톡 편집 메뉴에서 붙여넣기를 찾지 못했어요",
	pasteboard: "파일을 클립보드에 올리지 못했어요",
	pasted_text: "카카오톡이 파일 대신 글로 붙여 넣어서 지우고 보내지 않았어요",
	no_dialog: "카카오톡 파일 전송 창이 뜨지 않았어요",
};

const lastLogId = (list: Msg[]) => list.at(-1)?.logId ?? "0";

// A new message of the owner in the room after `after` that is not text: the file or photo that was just sent.
async function arrived(input: FileSendInput, after: string, deps: FileSendDeps): Promise<boolean> {
	const end = deps.now() + CONFIRM_MS;
	for (;;) {
		try {
			if ((await input.messages(20)).some(m => m.fromMe && !TEXT_TYPES.has(m.type) && newer(m.logId, after))) return true;
		} catch {}
		if (deps.now() >= end) return false;
		await deps.sleep(POLL_MS);
	}
}

export async function sendFilesToSelf(input: FileSendInput, deps: FileSendDeps): Promise<FileSendResult> {
	const steps: string[] = [];
	const fail = (sent: number, reason: string): FileSendResult => ({ ok: false, sent, reason, steps });
	if (input.room.kind !== "self") return fail(0, "나와의 채팅에만 파일을 보낼 수 있어요");
	const hint = input.all.findIndex(r => r.chatId === input.room.chatId);
	let sent = 0;
	try {
		for (const path of input.files) {
			let after: string;
			try {
				after = lastLogId(await input.messages(1));
			} catch {
				return fail(sent, "나와의 채팅을 읽지 못해서 보내지 않았어요");
			}
			const opened = await openRoom(input.room, input.all, deps.runner, hint >= 0 ? { hint } : {});
			steps.push(`open:${opened.ok}:${opened.steps.map(s => `${s.step}=${s.ok}`).join(",")}`);
			if (!opened.ok) return fail(sent, opened.reason);
			let r = await attach(deps.runner, input.room.name, path, false);
			// No dialog without KakaoTalk in front: once more with KakaoTalk briefly in front (the owner's app is put back at once).
			if (!r.ok && !r.pressed && r.why === "no_dialog") {
				steps.push(`attach:no_dialog:${r.seen ?? ""}`);
				r = await attach(deps.runner, input.room.name, path, true);
			}
			steps.push(`attach:${r.ok ? "ok" : r.why}${r.seen ? `:${r.seen}` : ""}`);
			if (!r.ok && !r.pressed) return fail(sent, WHY[r.why ?? ""] ?? "카카오톡에 파일을 넣지 못했어요");
			if (!(await arrived(input, after, deps))) return fail(sent, "전송은 눌렀지만 나와의 채팅에 파일이 들어왔는지 확인하지 못했어요. 다시 보내지 않았으니 카카오톡에서 확인해 주세요");
			sent++;
		}
		return { ok: true, sent, steps };
	} finally {
		await closeWindow(deps.runner, input.room.name);
	}
}
