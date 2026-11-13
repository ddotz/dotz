import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addInputDiag, cleanInputDiagEntry, INPUT_DIAG_CAP, inputDiagFile } from "./input-diag.ts";
import { ALLOW, makeRoute, webAccess } from "./routes.ts";

const OWNER = "owner@example.com";
const TS = "mini.tailnet.ts.net";
const route = makeRoute({ tailnetName: async () => TS, busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const entry = (n: number, extra: Record<string, unknown> = {}) => ({
	n, at: "2026-11-13T00:00:00.000Z", kind: "blur", app: "build-1", vis: "visible", hasFocus: true, active: "body",
	field: { sel: "textarea#text", tag: "textarea", type: "", id: "text", name: "", data: {}, ce: false },
	recent: [{ type: "pointerdown", on: "button#send-btn" }], stack: ["at focus (app.js:1:1)"], connected: true, to: "",
	after: { active: "body", activeIsField: false, connected: true, replaced: false, sameNodeFocused: false }, vh: { before: 544, after: 844 },
	...extra,
});
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, any>);
const unit = join(process.env.DOTZ_DIR!, "input-diag-unit.jsonl");

describe("input diagnostic file", () => {
	afterAll(() => rmSync(unit, { force: true }));

	test("keeps known fields cut to a length and nothing that could be typed text", () => {
		const raw = entry(1, { value: "typed words", text: "typed words", field: { ...entry(1).field, value: "typed words", sel: "x".repeat(900), data: { k: "y".repeat(90), ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`d${i}`, "v"])) } }, stack: Array.from({ length: 30 }, () => "z".repeat(400)) });
		const out = cleanInputDiagEntry(raw)!;
		const text = JSON.stringify(out);
		expect(text).not.toContain("typed words");
		expect((out.field as any).sel.length).toBe(200);
		expect(Object.keys((out.field as any).data).length).toBe(8);
		expect((out.stack as string[]).length).toBe(8);
		expect((out.stack as string[])[0]!.length).toBe(120);
		expect(cleanInputDiagEntry({ n: 1 })).toBeNull();
		expect(cleanInputDiagEntry("text")).toBeNull();
	});

	test("an entry over the cap pushes out the oldest", () => {
		rmSync(unit, { force: true });
		expect(addInputDiag({ entries: Array.from({ length: INPUT_DIAG_CAP }, (_, i) => entry(i)) }, unit)).toBe(INPUT_DIAG_CAP);
		expect(lines(unit).map(l => l.n)).toEqual(Array.from({ length: INPUT_DIAG_CAP }, (_, i) => i));
		expect(addInputDiag({ entries: [entry(INPUT_DIAG_CAP)] }, unit)).toBe(1);
		const all = lines(unit);
		expect(all.length).toBe(INPUT_DIAG_CAP);
		expect([all[0]!.n, all[all.length - 1]!.n]).toEqual([1, INPUT_DIAG_CAP]);
		expect(all.every(l => typeof l.got === "string")).toBe(true);
	});

	test("a body with no entry writes nothing", () => {
		rmSync(unit, { force: true });
		expect(addInputDiag({}, unit)).toBe(0);
		expect(addInputDiag({ entries: "x" }, unit)).toBe(0);
		expect(existsSync(unit)).toBe(false);
	});
});

describe("POST /api/input-diag", () => {
	const post = (headers: Record<string, string>, body: unknown) => route(new Request(`http://${TS}/api/input-diag`, { method: "POST", headers: { host: TS, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
	const page = { "tailscale-user-login": OWNER, "sec-fetch-site": "same-origin", origin: `https://${TS}` };
	beforeAll(async () => {
		ALLOW.add(OWNER);
		await webAccess.change({ mode: "tailscale" });
		rmSync(inputDiagFile(), { force: true });
	});
	afterAll(() => {
		ALLOW.delete(OWNER);
		rmSync(inputDiagFile(), { force: true });
		rmSync(join(process.env.DOTZ_DIR!, "web-access.json"), { force: true });
	});

	test("the owner's page is 201 and the entry lands; a request with no identity or from another site writes nothing", async () => {
		expect((await post({}, { entries: [entry(1)] })).status).toBeGreaterThanOrEqual(400);
		expect((await post({ ...page, "sec-fetch-site": "cross-site", origin: "https://evil.example" }, { entries: [entry(1)] })).status).toBe(403);
		expect(existsSync(inputDiagFile())).toBe(false);
		const r = await post(page, { app: "build-2", entries: [entry(7, { app: "" })] });
		expect(r.status).toBe(201);
		expect(await r.json()).toEqual({ ok: true, kept: 1 });
		expect(lines(inputDiagFile()).map(l => [l.n, l.app])).toEqual([[7, "build-2"]]);
	});
});
