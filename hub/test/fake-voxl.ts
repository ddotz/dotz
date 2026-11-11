// A stand-in for voxl (hub/remote-desktop.test.ts spawns it with the real voxl's flags). It is a file of the repo, not text written to os.tmpdir():
// bun lists the folders above a script it starts, and a tmpdir with hundreds of thousands of entries made every start take ~0.4 s before the first line ran.
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
const port = Number(args.find(a => a.startsWith("--port="))?.split("=")[1]);
const pw = process.env.VOXL_PASSWORD ?? "";
const mode = process.env.FAKE_MODE ?? "";
const sock = await Bun.connect({ hostname: "127.0.0.1", port: Number(process.env.FAKE_NOTIFY), socket: { data() { process.exit(0); } } });
const note = (m) => { sock.write(process.pid + " " + m + "\n"); sock.flush(); };
if (mode === "dyld-always" || (mode === "dyld-once" && !existsSync(process.env.FAKE_FLAG))) {
	console.error("dyld[1]: Library not loaded: /opt/homebrew/opt/x264/lib/libx264.165.dylib");
	process.exit(1);
}
// Exits on the test's answer to TERM (the socket's data handler above), so the note is never lost to the exit.
process.on("SIGTERM", () => { note(mode === "ignore-term" ? "TERM ignored" : "TERM"); });
const CHUNK = new Uint8Array(65536);
let sent = 0, total = 0, fin = false;
function pump(ws) {
	while (sent < total) {
		const r = ws.send(CHUNK);
		sent += CHUNK.length;
		if (r === -1) return note("blocked " + sent);
	}
	if (total && !fin) { fin = true; note("done " + sent); }
}
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch(req, srv) {
		const u = new URL(req.url);
		if (u.pathname === "/healthz") return new Response("ok");
		if (req.headers.get("authorization") !== "Bearer " + pw) return new Response("no", { status: 401, headers: { "www-authenticate": "Bearer" } });
		if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
		if (u.pathname === "/" || u.pathname === "/index.html") return Response.json({ headers: Object.fromEntries(req.headers) });
		if (u.pathname === "/client.js") return new Response("console.log('voxl')", { headers: { "content-type": "text/javascript", "set-cookie": "sid=1", "www-authenticate": "Bearer" } });
		if (u.pathname === "/screenshot") return new Response(new Uint8Array(3000).fill(0).map((_, i) => [0x89, 0x50, 0x4e, 0x47][i] ?? 0), { headers: { "content-type": "image/png" } });
		return new Response("nf", { status: 404 });
	},
	websocket: {
		open() { note("wsopen"); },
		message(ws, m) {
			if (typeof m === "string" && m.startsWith("flood:")) { total = Number(m.slice(6)); sent = 0; fin = false; pump(ws); }
			else if (m === "probe") note("probe " + sent);
			else ws.send(m);
		},
		drain(ws) { pump(ws); },
		close() { note("wsclosed"); },
	},
});
note("ready");
