// BEFORE / AFTER measurements of a running load install (called by run.ts): API latency and payload size, ingest flood, RSS, store write
// cost and fake-model turns. Everything goes through the real HTTP routes the web app uses; numbers carry their sample count.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTS } from "./names.ts";
import { rewritten, rssMb, sample, snapshot, stat, timed, watchRss, type Call } from "./measure.ts";

export type Ctx = {
	base: string;
	token: string;
	pid: number;
	out: string;
	dataDir: string;
	scale: "small" | "large";
	latency: number;
	bootMs: number;
	seedMs: number;
	seed: { counts: Record<string, number>; read: Record<string, unknown>; store: Record<string, unknown> };
	repoFiles: number;
	probe: { ok: boolean; text: string };
};

type Json = Record<string, any>;
type ModelCall = { kind: string; est_tokens: number; chars_in: number; item: string };

const A = ACCOUNTS[0]!, B = ACCOUNTS[1]!;
const mailCall = (acct: typeof A, id: string, ask: boolean): Call => ({
	method: "POST",
	path: "/api/mail",
	body: {
		source: acct.source, id, subject: `부하 시험 ${id}`, from: `보낸이 <${id}@sender.example.test>`, to: `${acct.owner} <${acct.address}>`, body: `안녕하세요, ${id} 건으로 연락드립니다.\n확인 부탁드립니다.`,
		at: new Date().toISOString(), messageId: `<${id}@sender.example.test>`, needsReply: ask, account: acct.address,
	},
});

export async function bench(c: Ctx): Promise<number> {
	const h = { "x-dotz-token": c.token };
	const small = c.scale === "small", N = small ? 30 : 40;
	const get = async (path: string): Promise<Json> => (await fetch(c.base + path, { headers: h })).json() as Promise<Json>;
	const post = async (path: string, body: unknown): Promise<Json> => (await fetch(c.base + path, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Json>;
	const modelFile = join(c.out, "model-calls.jsonl");
	const calls = (): ModelCall[] => (existsSync(modelFile) ? readFileSync(modelFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as ModelCall) : []);
	const turns = (from: number, to = Infinity) => {
		const by: Record<string, { calls: number; est_tokens: number }> = {};
		for (const m of calls().slice(from, to)) (by[m.kind] ??= { calls: 0, est_tokens: 0 }, by[m.kind]!.calls++, by[m.kind]!.est_tokens += m.est_tokens);
		return { total_calls: Object.values(by).reduce((s, x) => s + x.calls, 0), total_est_tokens: Object.values(by).reduce((s, x) => s + x.est_tokens, 0), by_kind: by };
	};
	// Quiet = no new model call and a steady RSS for three checks in a row; the wait is real, up to maxMs.
	const settle = async (maxMs: number) => {
		const t0 = performance.now();
		let last = calls().length, lastRss = await rssMb(c.pid), still = 0;
		while (performance.now() - t0 < maxMs && still < 3) {
			await Bun.sleep(2000);
			const n = calls().length, r = await rssMb(c.pid);
			still = n === last && Math.abs(r - lastRss) <= 1 ? still + 1 : 0;
			[last, lastRss] = [n, r];
		}
		return { waited_ms: Math.round(performance.now() - t0), rss_mb: lastRss, timed_out: still < 3 };
	};
	const res: Json = { scale: c.scale, fake_model_latency_ms: c.latency, samples_per_api_call: N };
	const notes: string[] = [];

	// Boot: backlog counts as the gateway sees them, boot time, model turns woken by the backlog, idle RSS.
	const boot = await settle(small ? 20_000 : 60_000);
	const bootTurns = turns(0);
	const bootN = calls().length;
	const notices0 = await get("/api/notices?limit=1000"), conv0 = await get("/api/conversations"), appr0 = await get("/api/approvals"), apps0 = await get("/api/apps");
	const approvalCards = (appr0.groups as Json[]).reduce((s, g) => s + (g.cards as unknown[]).length, 0);
	res.backlog = {
		seeded: c.seed.counts, read_back_by_real_readers: c.seed.read,
		gateway_sees: { notices: (notices0.items as unknown[]).length, conversations: (conv0.items as Json[]).length, mail_conversations: (conv0.items as Json[]).filter(i => i.mail).length, approval_cards: approvalCards, apps: (apps0.items as unknown[]).length },
		seed_store: c.seed.store,
	};
	res.boot = { seed_ms: c.seedMs, to_first_api_answer_ms: c.bootMs, settle: boot, rss_idle_mb: boot.rss_mb, model_turns_at_boot: bootTurns, gateway_files_copied: c.repoFiles };

	// API calls (each: sequential samples after one warm-up call; bytes = decoded body, gzip_bytes = on the wire when compressed).
	const items = conv0.items as Json[];
	const mailKeys = items.filter(i => i.mail).map(i => String(i.target).slice(5));
	const htmlKey = mailKeys.find(k => existsSync(join(c.dataDir, "mail-files", k, "body.html"))) ?? mailKeys[0]!;
	const api: Json = {};
	const get_ = (path: string) => () => ({ path });
	const run = async (name: string, build: (i: number) => Call) => void (api[name] = await sample(c.base, N, build, h));
	await run("state (web first load /api/state?limit=0)", get_("/api/state?limit=0"));
	await run("notices limit=100", get_("/api/notices?limit=100"));
	await run("notices limit=300 (what the web asks)", get_("/api/notices?limit=300"));
	await run("notices limit=1000", get_("/api/notices?limit=1000"));
	await run("drafts: approvals list (all pending cards)", get_("/api/approvals"));
	await run("drafts: replies list (kakao + comments)", get_("/api/replies"));
	await run("mail list: conversations (every mail, no paging)", get_("/api/conversations"));
	await run("one mail open: body", i => ({ path: `/api/mail/${encodeURIComponent(htmlKey)}/body?i=${i}` }));
	await run("one mail open: history", () => ({ path: `/api/history?target=${encodeURIComponent(`mail:${htmlKey}`)}&limit=150` }));
	await run("app list", get_("/api/apps"));
	await run("chat history (main)", get_("/api/history?target=main&limit=150"));
	await run("POST /api/mail (new mail, mail app)", i => mailCall(A, `bench-a${i}`, i % 3 === 0));
	await run("POST /api/mail (new mail, second mail app)", i => mailCall(B, `bench-b${i}`, i % 3 === 0));
	await run("POST /api/message (chat)", i => ({ method: "POST", path: "/api/message", body: { text: `부하 시험 인사 ${i}` } }));
	res.api = api;
	notes.push("No server-side mail search or paging exists: the mail app asks /api/conversations for every mail and filters in the page (web/js/31-conversations.js); notices have a `limit` only (no cursor).");

	// Store write cost: files that changed for one operation (data dir, two levels deep), after the writes settled.
	const writes: Json = {};
	const quiet = async () => {
		let prev = JSON.stringify([...snapshot(c.dataDir, 3)]), same = 0;
		for (let i = 0; i < 40 && same < 3; i++) {
			await Bun.sleep(500);
			const now = JSON.stringify([...snapshot(c.dataDir, 3)]);
			same = now === prev ? same + 1 : 0;
			prev = now;
		}
	};
	await quiet();
	const card = (appr0.groups as Json[]).flatMap(g => g.cards as Json[]).find(x => x.sendable);
	if (card) {
		const before = snapshot(c.dataDir, 3);
		const t = await timed(c.base, { method: "POST", path: "/api/approvals", body: { items: [{ ref: card.ref, to: card.to, n: 1 }] } }, h);
		await quiet();
		writes.draft_status_change = { request_ms: Math.round(t.ms * 100) / 100, status: t.status, files_rewritten: rewritten(before, snapshot(c.dataDir, 3)).slice(0, 6) };
	}
	const unread = (notices0.items as Json[]).find(n => !n.read);
	if (unread) {
		const before = snapshot(c.dataDir, 3);
		const t = await timed(c.base, { method: "POST", path: "/api/notices/read", body: { ids: [unread.id] } }, h);
		await quiet();
		writes.notice_update_read = { request_ms: Math.round(t.ms * 100) / 100, status: t.status, files_rewritten: rewritten(before, snapshot(c.dataDir, 3)).slice(0, 6) };
	}
	res.store_write_cost = writes;

	// Ingest flood: 500 new mails on the mail app at concurrency 8, while a chat message, a mail of the other app and /api/state are timed.
	const baseline = { chat: api["POST /api/message (chat)"].latency_ms, other_app_mail: api["POST /api/mail (new mail, second mail app)"].latency_ms, state: api["state (web first load /api/state?limit=0)"].latency_ms };
	const before = calls().length, noticesBefore = ((await get("/api/notices?limit=1000")).items as unknown[]).length;
	const flood = 500, conc = 8;
	const watch = watchRss(c.pid, 200), floodLat: number[] = [], failed: number[] = [];
	const during = { chat: [] as number[], other_app_mail: [] as number[], state: [] as number[] };
	let next = 0, running = true;
	const t0 = performance.now();
	const workers = Array.from({ length: conc }, async () => {
		for (let i = next++; i < flood; i = next++) {
			const t = await timed(c.base, mailCall(A, `flood-${i}`, i % 3 === 0), h);
			floodLat.push(t.ms);
			if (t.status !== 200) failed.push(t.status);
		}
	});
	const probes = (async () => {
		let i = 0;
		while (running) {
			during.chat.push((await timed(c.base, { method: "POST", path: "/api/message", body: { text: `flood 인사 ${i}` } }, h)).ms);
			during.other_app_mail.push((await timed(c.base, mailCall(B, `flood-b${i}`, false), h)).ms);
			during.state.push((await timed(c.base, { path: "/api/state?limit=0" }, h)).ms);
			i++;
			await Bun.sleep(50);
		}
	})();
	await Promise.all(workers);
	const floodMs = performance.now() - t0;
	running = false;
	await probes;
	const peak = await watch.stop();
	const afterFlood = turns(before);
	const settled = await settle(small ? 20_000 : 180_000);
	const floodTurns = turns(before);
	res.flood = {
		mails: flood, concurrency: conc, total_ms: Math.round(floodMs), mails_per_s: Math.round((flood / floodMs) * 10000) / 10, post_latency_ms: stat(floodLat), post_failures: failed.length,
		during_flood_latency_ms: { chat_message: stat(during.chat), other_app_mail: stat(during.other_app_mail), state: stat(during.state) }, idle_baseline_latency_ms: baseline,
		notices_before: noticesBefore, notices_after: ((await get("/api/notices?limit=1000")).items as unknown[]).length,
	};
	res.rss_mb = { idle_after_boot: boot.rss_mb, peak_in_flood: peak, settled: settled.rss_mb, settle_wait_ms: settled.waited_ms, settle_timed_out: settled.timed_out };
	res.model_turns = {
		fake_model_latency_ms: c.latency, at_boot: bootTurns, calls_before_flood: bootN, during_flood_until_ingest_done: afterFlood, flood_plus_settle: floodTurns,
		per_100_new_mails: { calls: Math.round((floodTurns.total_calls / flood) * 1000) / 10, est_tokens: Math.round((floodTurns.total_est_tokens / flood) * 1000) / 10 },
	};

	// What the fakes recorded: every CLI call, the would-be sends.
	const shim = existsSync(join(c.out, "shim-calls.jsonl")) ? readFileSync(join(c.out, "shim-calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Json) : [];
	const byTool: Record<string, number> = {};
	for (const s of shim) byTool[s.tool] = (byTool[s.tool] ?? 0) + 1;
	const sends = shim.filter(s => s.would_send);
	res.shim = { calls_by_tool: byTool, would_send: sends.length, would_send_sample: sends.slice(0, 5).map(s => ({ tool: s.tool, argv: (s.argv as string[]).slice(0, 4) })) };
	res.isolation_probe = { ok: c.probe.ok };

	// Checks: a failed one makes the run exit non-zero.
	const bad: string[] = [];
	const want = c.scale === "large" ? { mails: 5000, draftsPending: 500, notices: 1000 } : { mails: 100, draftsPending: 20, notices: 50 };
	for (const [k, v] of Object.entries(want)) if (c.seed.counts[k] !== v) bad.push(`seed ${k} ${c.seed.counts[k]} != ${v}`);
	for (const [k, v] of Object.entries(api as Record<string, { statuses: Record<string, number> }>)) if (Object.keys(v.statuses).some(s => s !== "200")) bad.push(`${k}: statuses ${JSON.stringify(v.statuses)}`);
	if (failed.length) bad.push(`${failed.length} flood posts failed (${[...new Set(failed)].join(",")})`);
	if (!c.probe.ok) bad.push("isolation probe has a [FAIL] line");
	if (!calls().length) bad.push("the fake model recorded no call");
	res.checks = { failed: bad };
	res.notes = notes;
	writeFileSync(join(c.out, "results.json"), `${JSON.stringify(res, null, 2)}\n`);
	writeFileSync(join(c.out, "results.md"), render(res, c));
	console.log(`results: ${join(c.out, "results.md")}${bad.length ? `\nFAILED: ${bad.join("; ")}` : ""}`);
	return bad.length ? 1 : 0;
}

const row = (cells: unknown[]): string => `| ${cells.join(" | ")} |`;
const lat = (s: { n: number; p50: number; p95: number; max: number }): string => `${s.p50} / ${s.p95} / ${s.max} (n=${s.n})`;
function render(r: Json, c: Ctx): string {
	const L: string[] = [`# Load measurements, ${r.scale} scale`, "", `Fake model latency ${r.fake_model_latency_ms} ms. Latencies are p50 / p95 / max in ms. The gateway runs sandboxed from a copy of the working tree (${c.repoFiles} files).`, ""];
	L.push("## Backlog (what the install holds)", "", `Seeded: ${JSON.stringify(r.backlog.seeded)}`, "", `The gateway sees: ${JSON.stringify(r.backlog.gateway_sees)}`, "", `Seed store facts: ${JSON.stringify(r.backlog.seed_store)}`, "");
	L.push("## Boot", "", `Seed ${r.boot.seed_ms} ms; boot to first API answer ${r.boot.to_first_api_answer_ms} ms; RSS idle ${r.boot.rss_idle_mb} MB (settled after ${r.boot.settle.waited_ms} ms).`, "", `Model turns the backlog woke at boot: ${JSON.stringify(r.boot.model_turns_at_boot)}`, "");
	L.push("## API (decoded bytes; gzip = wire bytes when compressed)", "", row(["call", "latency p50 / p95 / max", "bytes", "gzip"]), row(["---", "---", "---", "---"]));
	for (const [k, v] of Object.entries(r.api as Record<string, Json>)) L.push(row([k, lat(v.latency_ms), v.bytes, v.gzip_bytes ?? "-"]));
	L.push("", "## Store write cost (files changed by one operation)", "");
	for (const [k, v] of Object.entries(r.store_write_cost as Record<string, Json>)) L.push(`- ${k}: request ${v.request_ms} ms (status ${v.status}); rewritten: ${(v.files_rewritten as Json[]).map(f => `${f.file.replace(c.dataDir, "")} ${f.bytes} B`).join(", ") || "none"}`);
	const f = r.flood as Json;
	L.push("", `## Ingest flood (${f.mails} mails, concurrency ${f.concurrency})`, "", `Done in ${f.total_ms} ms (${f.mails_per_s} mails/s); POST latency ${lat(f.post_latency_ms)}; failures ${f.post_failures}.`, "", row(["while flooding", "during", "idle baseline"]), row(["---", "---", "---"]));
	for (const k of ["chat_message", "other_app_mail", "state"]) L.push(row([k, lat(f.during_flood_latency_ms[k]), lat(f.idle_baseline_latency_ms[k === "chat_message" ? "chat" : k])]));
	L.push("", `Notices before / after the flood: ${f.notices_before} / ${f.notices_after}.`, "", "## Gateway RSS", "", `idle ${r.rss_mb.idle_after_boot} MB, peak in flood ${r.rss_mb.peak_in_flood} MB, settled ${r.rss_mb.settled} MB (waited ${r.rss_mb.settle_wait_ms} ms${r.rss_mb.settle_timed_out ? ", did not fully settle" : ""}).`, "");
	L.push("## Model turns (fake model, estimated tokens)", "", `At boot: ${JSON.stringify(r.model_turns.at_boot)}`, "", `Flood until ingest done: ${JSON.stringify(r.model_turns.during_flood_until_ingest_done)}`, "", `Flood plus settle: ${JSON.stringify(r.model_turns.flood_plus_settle)}`, "", `Per 100 new mails: ${JSON.stringify(r.model_turns.per_100_new_mails)}`, "");
	L.push("## Fakes", "", `CLI calls by tool: ${JSON.stringify(r.shim.calls_by_tool)}; would-be sends recorded: ${r.shim.would_send}.`, "", "## Notes", "", ...(r.notes as string[]).map(n => `- ${n}`), "", `Checks failed: ${(r.checks.failed as string[]).join("; ") || "none"}`, "");
	return L.join("\n");
}
