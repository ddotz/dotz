// Step 1+2 runner: turn a recording of the webmail client's own XHR/JSON calls into a SiteSpec proposal in the custom layer.
// `--from <file>` reads a recording the orchestrator already made (a HAR export, or a JSON array of {url,method,status,
// responseBody}); `--record` drives a background Aside tab to make one itself (never focused, closed at once). Only field
// names and URL shapes are inferred and written; the raw recording stays with the owner and is never shipped.
import { readFileSync } from "node:fs";
import { capture, type CapturedRequest } from "../lib/capture.ts";
import { validateSpec } from "../lib/spec.ts";
import { paths, writeJson } from "../lib/config.ts";

// A HAR file (browser devtools / Aside export) normalized to the small shape the generator reads.
export function fromHar(har: any): CapturedRequest[] {
	const entries = har?.log?.entries;
	if (!Array.isArray(entries)) return [];
	return entries.map((e: any) => ({
		url: e?.request?.url ?? "",
		method: e?.request?.method,
		status: e?.response?.status,
		contentType: (e?.response?.content?.mimeType as string) ?? (e?.response?.headers ?? []).find((h: any) => /content-type/i.test(h?.name))?.value,
		responseBody: e?.response?.content?.text,
	})).filter((r: CapturedRequest) => r.url);
}

export function normalize(raw: unknown): CapturedRequest[] {
	if (Array.isArray(raw)) return raw as CapturedRequest[];
	if (raw && typeof raw === "object" && (raw as any).log) return fromHar(raw);
	return [];
}

// Best-effort live recording: in a background tab at `origin`, wrap fetch/XHR to remember each JSON response, visit the
// inbox URL, and read what was recorded. Returns the raw request list for the generator.
export async function recordViaAside(origin: string, inboxUrl: string): Promise<CapturedRequest[]> {
	const hook = `const t = await openTab(${JSON.stringify(origin)});
		try {
			const p = await attachBrowserTab(t.targetId ?? t.id ?? t);
			await p.evaluate(() => { window.__wm = []; const push = async (url, method, res) => { try { const ct = res.headers.get('content-type') || ''; if (/json/i.test(ct)) window.__wm.push({ url, method, status: res.status, contentType: ct, responseBody: await res.clone().text() }); } catch (e) {} };
				const of = window.fetch; window.fetch = async (...a) => { const r = await of(...a); push(typeof a[0] === 'string' ? a[0] : a[0].url, (a[1] && a[1].method) || 'GET', r); return r; }; });
			await p.evaluate((u) => fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }).then(r => r.text()).catch(() => ''), ${JSON.stringify(inboxUrl)});
			await new Promise(r => setTimeout(r, 2500));
			const caps = await p.evaluate(() => JSON.stringify(window.__wm || []));
			console.log('WM_CAPS ' + caps);
		} finally { await closeTab(t).catch(() => {}); }`;
	const proc = Bun.spawn(["aside", "repl", hook], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(9), 60_000);
	const out = await new Response(proc.stdout).text().catch(() => "");
	await proc.exited;
	clearTimeout(timer);
	const line = out.split("\n").find((l) => l.startsWith("WM_CAPS "));
	if (!line) return [];
	try {
		return JSON.parse(line.slice("WM_CAPS ".length)) as CapturedRequest[];
	} catch {
		return [];
	}
}

async function main(argv: string[]): Promise<number> {
	const site = argv[0] ?? "";
	const fromIdx = argv.indexOf("--from");
	let requests: CapturedRequest[] = [];
	if (fromIdx >= 0) {
		requests = normalize(JSON.parse(readFileSync(argv[fromIdx + 1], "utf8")));
	} else if (argv.includes("--record")) {
		const origin = argv[argv.indexOf("--record") + 1] ?? "";
		const inbox = argv[argv.indexOf("--inbox") + 1] ?? origin;
		requests = await recordViaAside(origin, inbox);
	} else {
		console.log("usage: capture.ts <site> --from <recording.json|.har> | --record <origin> [--inbox <url>]");
		return 1;
	}
	const { spec, notes } = capture(site, requests);
	for (const n of notes) console.log(n);
	if (!spec || validateSpec(spec)) {
		console.log("아직 완전한 스펙을 만들지 못했어요. 로그인한 채로 받은메일함과 메일 한 통을 연 뒤 다시 캡처해 주세요");
		if (spec) writeJson(`${paths.spec(site)}.draft`, spec);
		return 1;
	}
	writeJson(paths.spec(site), spec);
	console.log(`스펙 저장: ${paths.spec(site)}`);
	return 0;
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
