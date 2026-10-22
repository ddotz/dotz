// Recording the webmail client's own XHR/JSON calls, for the adapter generator (lib/capture.ts). Two sources:
// - `recordViaAside(url, deep)`: one background Aside tab (never focused, closed at the end). Calls the page made while
//   loading are found in its Performance entries and fetched again with the same cookies; fetch/XHR are wrapped so later
//   calls keep their real method and body; one mail is opened by clicking a subject taken from the list JSON, so the read
//   call is seen too. `deep` also scrolls every scroller and clicks an inbox link, for clients that load lazily.
// - a HAR export (`--har` / `--from`), for sites the live recording cannot read.
// Only field names and URL shapes leave this step (lib/capture.ts); the raw recording is kept nowhere.
import { readFileSync } from "node:fs";
import { capture, type CapturedRequest } from "../lib/capture.ts";
import { paths, writeJson } from "../lib/config.ts";

export function fromHar(har: any): CapturedRequest[] {
	const entries = har?.log?.entries;
	if (!Array.isArray(entries)) return [];
	return entries.map((e: any) => ({
		url: e?.request?.url ?? "",
		method: e?.request?.method,
		status: e?.response?.status,
		contentType: (e?.response?.content?.mimeType as string) ?? (e?.response?.headers ?? []).find((h: any) => /content-type/i.test(h?.name))?.value,
		responseBody: e?.response?.content?.text,
		requestBody: e?.request?.postData?.text,
	})).filter((r: CapturedRequest) => r.url);
}

export function normalize(raw: unknown): CapturedRequest[] {
	if (Array.isArray(raw)) return raw as CapturedRequest[];
	if (raw && typeof raw === "object" && (raw as any).log) return fromHar(raw);
	return [];
}

export const readRecording = (file: string): CapturedRequest[] => normalize(JSON.parse(readFileSync(file, "utf8")));

const MAX_CALLS = 40;
const MAX_BODY = 200_000;

// Runs inside the page. Kept as plain JS text: aside repl evaluates it in the tab.
const PAGE_SIDE = String.raw`
const MAX_CALLS = ${MAX_CALLS}, MAX_BODY = ${MAX_BODY};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const looksJson = (ct, t) => /json/i.test(ct) || /^\s*(\)\]\}',?\s*)?[\[{]/.test(t);
window.__wm = window.__wm || { out: [], seen: new Set() };
const W = window.__wm;
const keep = (c) => { if (W.out.length < MAX_CALLS && looksJson(c.contentType || '', c.responseBody || '')) W.out.push({ ...c, responseBody: (c.responseBody || '').slice(0, MAX_BODY) }); };
const replayLoaded = async () => {
	const entries = performance.getEntriesByType('resource').filter((e) => (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && new URL(e.name).origin === location.origin);
	for (const e of entries) {
		if (W.seen.has(e.name) || W.out.length >= MAX_CALLS) continue;
		W.seen.add(e.name);
		try {
			const r = await fetch(e.name, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*' } });
			keep({ url: e.name, method: 'GET', status: r.status, contentType: r.headers.get('content-type') || '', responseBody: await r.text() });
		} catch (err) {}
	}
};
const hook = () => {
	if (W.hooked) return;
	W.hooked = true;
	const of = window.fetch;
	window.fetch = async (input, init) => {
		const res = await of(input, init);
		try {
			const url = new URL(typeof input === 'string' ? input : input.url, location.href).href;
			W.seen.add(url);
			const body = init && typeof init.body === 'string' ? init.body : undefined;
			keep({ url, method: (init && init.method) || 'GET', status: res.status, contentType: res.headers.get('content-type') || '', responseBody: await res.clone().text(), requestBody: body });
		} catch (err) {}
		return res;
	};
	const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (m, u) { this.__wm = { method: m, url: new URL(u, location.href).href }; return open.apply(this, arguments); };
	XMLHttpRequest.prototype.send = function (b) {
		const x = this;
		x.addEventListener('load', () => { try { W.seen.add(x.__wm.url); keep({ url: x.__wm.url, method: x.__wm.method, status: x.status, contentType: x.getResponseHeader('content-type') || '', responseBody: typeof x.response === 'string' ? x.response : x.responseText, requestBody: typeof b === 'string' ? b : undefined }); } catch (err) {} });
		return send.apply(this, arguments);
	};
};
const firstSubject = () => {
	for (const c of W.out) {
		let j; try { j = JSON.parse(c.responseBody.replace(/^\s*\)\]\}',?\s*/, '')); } catch (err) { continue; }
		const stack = [j];
		while (stack.length) {
			const v = stack.shift();
			if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object') for (const [k, x] of Object.entries(it)) if (/subject|title/i.test(k) && typeof x === 'string' && x.trim().length > 3) return x.trim(); }
			else if (v && typeof v === 'object') stack.push(...Object.values(v));
		}
	}
	return '';
};
const clickText = (needle) => {
	const els = [...document.querySelectorAll('a, td, span, div, li, p')].filter((e) => e.children.length <= 3 && (e.textContent || '').includes(needle));
	const el = els[els.length - 1];
	if (el) { el.click(); return true; }
	return false;
};
`;

const recordCode = (url: string, deep: boolean) => `const pg = await openTab(${JSON.stringify(url)});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
	await sleep(${deep ? 7000 : 4000});
	const first = JSON.parse(await pg.evaluate(async (deep) => { ${PAGE_SIDE}
		hook();
		await replayLoaded();
		if (deep) {
			for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
			const inbox = [...document.querySelectorAll('a, span, li, div')].find((e) => e.children.length <= 2 && /^(받은\\s?(편지|메일)함|inbox)$/i.test((e.textContent || '').trim()));
			if (inbox) inbox.click();
			await sleep(3000);
			await replayLoaded();
		}
		return JSON.stringify({ out: W.out, subject: firstSubject() });
	}, ${deep}));
	if (first.subject) await pg.evaluate((needle) => { ${PAGE_SIDE} clickText(needle); return 1; }, first.subject.slice(0, 40)).catch(() => 0);
	await sleep(${deep ? 6000 : 4000});
	const later = JSON.parse(await pg.evaluate(async () => { ${PAGE_SIDE}
		await replayLoaded();
		return JSON.stringify(window.__wm.out);
	}).catch(() => '[]'));
	const byUrl = new Map();
	for (const c of [...first.out, ...later]) if (!byUrl.has(c.method + ' ' + c.url)) byUrl.set(c.method + ' ' + c.url, c);
	console.log('WM_CAPS ' + JSON.stringify([...byUrl.values()]));
} finally {
	await closeTab(pg).catch(() => {});
}`;

// The page may navigate when a mail is opened (a full page load drops the page's recording), so the first pass's calls are
// kept on the repl side and merged with whatever the page (old or new) recorded after the click.
export async function recordViaAside(url: string, deep: boolean): Promise<CapturedRequest[]> {
	const proc = Bun.spawn(["aside", "repl", recordCode(url, deep)], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(9), 90_000);
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
	const fileIdx = Math.max(argv.indexOf("--from"), argv.indexOf("--har"));
	let requests: CapturedRequest[];
	if (fileIdx >= 0) requests = readRecording(argv[fileIdx + 1]);
	else if (argv.includes("--record")) requests = await recordViaAside(argv[argv.indexOf("--record") + 1] ?? "", argv.includes("--deep"));
	else {
		console.log("사용법: capture.ts <site> --record <받은메일함 URL> [--deep] | --har <파일.har>");
		return 1;
	}
	const res = capture(site, requests);
	for (const n of res.notes) console.log(n);
	if (res.kind !== "ok" || !res.spec) return 1;
	writeJson(paths.spec(site), res.spec);
	console.log(`설정 저장: ${paths.spec(site)}`);
	return 0;
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
