// A fake KakaoTalk screen for the send tests: the chat list (`kmsg chats`), the window each row opens (what room.jxa.js reads) and a
// record of every send, so a test can see that nothing was typed. Nothing here touches the real app.
import type { WindowFacts } from "./room.ts";
import type { Runner } from "./types.ts";

export type FakeRow = { id: string; title: string; window?: WindowFacts | "unreadable" };
type SendOut = { code: number; stdout: string; stderr?: string };

export function fakeScreen(rows: FakeRow[], opts: { front?: string; sendOut?: (argv: string[]) => SendOut } = {}) {
	const opened: string[] = [];
	const sends: string[][] = [];
	const focus: string[][] = [];
	let closes = 0;
	let current: string | undefined;
	const runner: Runner = async (argv, o) => {
		if (argv[0] === "open") {
			focus.push(argv);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (argv[0] === "osascript" && argv[1] !== "-l") {
			focus.push(argv);
			return { code: 0, stdout: `${opts.front ?? "com.example.Editor"}\n`, stderr: "" };
		}
		if (argv[0] === "osascript") {
			if (JSON.parse((o?.stdin ?? "{}").trim()).action === "close") {
				closes++;
				current = undefined;
				return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
			}
			const w = rows.find(r => r.id === current)?.window;
			if (w === "unreadable" || w === undefined) return { code: 0, stdout: '{"ok":false}\n', stderr: "" };
			return { code: 0, stdout: `${JSON.stringify({ ok: true, windows: [w] })}\n`, stderr: "" };
		}
		const cmd = argv[1];
		if (cmd === "chats") return { code: 0, stdout: JSON.stringify({ chats: rows.map(r => ({ chat_id: r.id, title: r.title, last_message: "" })) }), stderr: "" };
		if (cmd === "read") {
			current = argv[argv.indexOf("--chat-id") + 1];
			opened.push(current!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "send") {
			sends.push(argv);
			return { stderr: "", ...(opts.sendOut?.(argv) ?? { code: 0, stdout: "sent\n" }) };
		}
		throw new Error(`unexpected kmsg call ${argv.join(" ")}`);
	};
	return { runner, opened, sends, focus, closes: () => closes };
}
