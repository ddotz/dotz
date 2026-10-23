// A fake KakaoTalk screen for the send tests: the chat list (`kmsg chats`), the window each row opens (what room.jxa.js reads) and a
// record of every send, so a test can see that nothing was typed. Nothing here touches the real app.
import type { WindowFacts } from "./room.ts";
import type { Runner } from "./types.ts";

export type FakeRow = { id: string; title: string; window?: WindowFacts | "unreadable" };
type SendOut = { code: number; stdout: string; stderr?: string };

// `axOpen`: the list rows can be opened by Accessibility (room.jxa.js open); off, the open reports no list window, as before that path.
// `axSend`: the JSON room.jxa.js send prints (default {ok:true}); its sends are recorded as ["ax-send", name, text].
export function fakeScreen(rows: FakeRow[], opts: { front?: string; kakaoShown?: boolean; axOpen?: boolean; axSend?: () => object; sendOut?: (argv: string[]) => SendOut } = {}) {
	const opened: string[] = [];
	const sends: string[][] = [];
	const focus: string[][] = [];
	const limits: number[] = [];
	const order: string[] = [];
	let closes = 0;
	let current: string | undefined;
	const runner: Runner = async (argv, o) => {
		if (argv[0] === "open") {
			focus.push(argv);
			order.push("open");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (argv[0] === "osascript" && argv[1] !== "-l") {
			focus.push(argv);
			order.push("front");
			return { code: 0, stdout: `${opts.front ?? "com.example.Editor"} ${opts.kakaoShown ? 1 : 0}\n`, stderr: "" };
		}
		if (argv[0] === "osascript") {
			const req = JSON.parse((o?.stdin ?? "{}").trim());
			if (req.action === "open") {
				if (!opts.axOpen) return { code: 0, stdout: '{"ok":false,"why":"none"}\n', stderr: "" };
				const hits = rows.slice(0, req.rows).filter(r => r.title === req.name);
				if (hits.length !== 1) return { code: 0, stdout: `${JSON.stringify({ ok: false, why: hits.length ? "many" : "none" })}\n`, stderr: "" };
				current = hits[0]!.id;
				opened.push(`ax:${current}`);
				order.push("ax-open");
				return { code: 0, stdout: '{"ok":true,"row":0}\n', stderr: "" };
			}
			if (req.action === "send") {
				sends.push(["ax-send", req.name, req.text]);
				order.push("send");
				return { code: 0, stdout: `${JSON.stringify(opts.axSend?.() ?? { ok: true })}\n`, stderr: "" };
			}
			if (req.action === "close") {
				closes++;
				current = undefined;
				return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
			}
			const w = rows.find(r => r.id === current)?.window;
			if (w === "unreadable" || w === undefined) return { code: 0, stdout: '{"ok":false}\n', stderr: "" };
			return { code: 0, stdout: `${JSON.stringify({ ok: true, windows: [w] })}\n`, stderr: "" };
		}
		const cmd = argv[1];
		if (cmd === "chats") limits.push(Number(argv[argv.indexOf("--limit") + 1]));
		if (cmd === "chats") return { code: 0, stdout: JSON.stringify({ chats: rows.map(r => ({ chat_id: r.id, title: r.title, last_message: "" })) }), stderr: "" };
		if (cmd === "read") {
			current = argv[argv.indexOf("--chat-id") + 1];
			opened.push(current!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "send") {
			sends.push(argv);
			order.push("send");
			return { stderr: "", ...(opts.sendOut?.(argv) ?? { code: 0, stdout: "sent\n" }) };
		}
		throw new Error(`unexpected kmsg call ${argv.join(" ")}`);
	};
	return { runner, opened, sends, focus, limits, order, closes: () => closes };
}
