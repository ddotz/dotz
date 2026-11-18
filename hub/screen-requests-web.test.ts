import { afterAll, describe, expect, test } from "bun:test";
import { startDemoServer, waitFor } from "./layout-measure.ts";

// One screen change asks the hub for each thing once: callers that need the same list at the same time share one request instead of sending it again.
const server = startDemoServer({ now: Date.UTC(2026, 10, 9, 3, 0, 0) });
const view = new Bun.WebView({ width: 390, height: 844 });
afterAll(() => { view.close(); server.stop(); });

const READY = `typeof S !== "undefined" && S && typeof target === "string" && CV.loaded && NT.loaded`;
// __fly counts the requests that were sent and have not settled: a screen change is over when its ready condition holds, every request it is known to
// send was seen, and nothing is in flight.
const HOOK = `(() => { window.__req = []; window.__fly = 0; const f = window.fetch; window.fetch = function (i, o) { let p; try { const u = new URL(typeof i === "string" ? i : i instanceof URL ? i.href : i.url, location.href); if (u.pathname.startsWith("/api/")) __req.push(String((o && o.method) || "GET").toUpperCase() + " " + u.pathname + u.search); } catch {} __fly++; p = f.apply(this, arguments); p.then(() => __fly--, () => __fly--); return p; }; return 0; })()`;

await view.navigate(`${server.origin}/?req=1#home`);
await waitFor(view, READY);
await view.evaluate(HOOK);

async function change(away: string, reach: string, ready: string, known: string[]): Promise<string[]> {
	await view.evaluate(`(${away}, 0)`);
	await waitFor(view, `__fly === 0`, 12_000);
	await view.evaluate(`(__req.length = 0, 0)`);
	await view.evaluate(`(${reach}, 0)`);
	await waitFor(view, `(${ready}) && ${JSON.stringify(known)}.every(q => __req.includes(q)) && __fly === 0`, 12_000);
	return JSON.parse((await view.evaluate(`JSON.stringify(__req)`)) as string);
}
const repeated = (req: string[]) => req.filter((q, i) => req.indexOf(q) !== i);

describe("requests of one screen change", () => {
	test("opening a mail thread asks for the integrations once", async () => {
		const req = await change(`go("home")`, `go("monitoring", "c:mail:m-1")`, `current === "chat" && CV.placed && target.startsWith("mail:")`, ["GET /api/history?target=mail%3Am-1&limit=150", "GET /api/integrations/mail/settings", "POST /api/read", "GET /api/integrations"]);
		expect(req.filter(q => q === "GET /api/integrations").length).toBe(1);
		expect(repeated(req)).toEqual([]);
	}, 60_000);

	test("opening the mail list asks for nothing twice", async () => {
		const req = await change(`go("home")`, `go("monitoring", "i:mail")`, `NM.loaded && MON.sel === "i:mail"`, ["GET /api/integrations"]);
		expect(repeated(req)).toEqual([]);
	}, 60_000);

	test("opening the settings asks for nothing twice", async () => {
		const req = await change(`go("home")`, `go("settings")`, `current === "settings" && !!document.querySelector("#settings > *")`, ["GET /api/api-budget", "GET /api/messengers", "GET /api/runtimes", "GET /api/devices", "GET /api/web-access", "GET /api/accounts"]);
		expect(repeated(req)).toEqual([]);
	}, 60_000);
});
