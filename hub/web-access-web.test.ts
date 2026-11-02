import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";

// 설정 → 웹 접속 against a stub gateway (headless Bun.WebView). The stub keeps what a PUT sends like the real route and never returns the token, only
// token_set. Screenshots go to SHOTS.
const SHOTS = process.env.MESSENGER_SHOTS ?? "/tmp/dotz-messenger-shots";
mkdirSync(SHOTS, { recursive: true });

const TOKEN = "eyJ-secret-tunnel-token-value";
let wa: Record<string, any>;
let found = true;
const puts: any[] = [];
const reset = () => {
	wa = { mode: "tailscale", hostname: "", team: "", aud: "", token_set: false, tunnel: { state: "off" }, devices: 0 };
	found = true;
	puts.length = 0;
};
reset();
const view = () => ({ ...wa, cloudflared_found: found });

const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/web-access" && req.method === "GET") return json(view());
		if (p === "/api/web-access" && req.method === "PUT") {
			const b = (await req.json()) as any;
			puts.push(b);
			const { token, ...rest } = b;
			wa = { ...wa, ...rest };
			if (token !== undefined) wa.token_set = token !== "";
			wa.tunnel = wa.mode === "cloudflare" ? (found ? { state: "running" } : { state: "error", error: "cloudflared를 찾을 수 없습니다" }) : { state: "off" };
			return json(view());
		}
		if (p === "/api/devices") return json([]);
		if (p === "/api/accounts") return json({ error: "none" }, 404);
		if (p === "/api/update") {
			const at = { sha: "a".repeat(40), short: "a".repeat(7), date: new Date(0).toISOString() };
			return json({ running: { kind: "git", branch: "main", commit: at }, disk: { kind: "git", branch: "main", commit: at }, settings: { auto_check: false, auto_apply: false, at: "09:00" }, busy: [] });
		}
	},
});
afterAll(() => hub.stop());

const open = async (width = 1280, height = 800, theme: "light" | "dark" = "light"): Promise<View> => {
	const v = await hub.view({ width, height }, "/");
	await waitFor(v, `typeof go === "function" && typeof S !== "undefined" && S`);
	await run(v, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; WA.draft = null; go("webaccess")`);
	await waitFor(v, `document.querySelector("#webaccess .seg")`);
	return v;
};
const click = (v: View, sel: string) => run(v, `document.querySelector(${JSON.stringify(sel)}).click()`);
const type = (v: View, sel: string, text: string) => run(v, `const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true }))`);
const confirm = (v: View, label: string) => run(v, `[...document.querySelectorAll("dialog .btn")].find(b => b.textContent === ${JSON.stringify(label)}).click()`);

describe("웹 접속 화면", () => {
	test("the settings list links to it and shows the current mode", async () => {
		reset();
		const v = await hub.view({ width: 1280, height: 800 }, "/");
		await waitFor(v, `typeof go === "function" && S`);
		await run(v, `go("settings")`);
		await waitFor(v, `[...document.querySelectorAll("#settings .li")].some(x => x.querySelector(".hd")?.textContent === "웹 접속" && x.querySelector(".sup")?.textContent === "Tailscale")`);
		await run(v, `[...document.querySelectorAll("#settings .li")].find(x => x.querySelector(".hd")?.textContent === "웹 접속").click()`);
		await waitFor(v, `current === "webaccess" && document.querySelector("#webaccess .seg")`);
	});

	test("off by default: Tailscale is chosen, no Cloudflare fields, nothing to save", async () => {
		reset();
		const v = await open();
		const s = await ev<{ on: string; fields: string[]; save: boolean; help: string }>(v, `({ on: document.querySelector("#webaccess .seg .on").dataset.v, fields: [...document.querySelectorAll("#webaccess input")].map(i => i.name), save: document.querySelector("[data-wa-save]").disabled, help: document.querySelector("[data-wa-help]").textContent })`);
		expect(s).toMatchObject({ on: "tailscale", fields: [], save: true });
		expect(s.help).toContain("기본값");
	});

	test("Cloudflare needs an address and a token; the confirm warns about Tailscale; the save sends only what is typed", async () => {
		reset();
		const v = await open();
		await click(v, '#webaccess .seg [data-v="cloudflare"]');
		await waitFor(v, `document.querySelector('#webaccess input[name="wa-hostname"]')`);
		expect(await ev(v, `[...document.querySelectorAll("#webaccess input")].map(i => i.name)`)).toEqual(["wa-hostname", "wa-team", "wa-aud", "wa-token"]);
		await click(v, "[data-wa-save]");
		expect(puts).toEqual([]);
		await type(v, 'input[name="wa-hostname"]', " dotz.example.com ");
		await click(v, "[data-wa-save]");
		expect(puts).toEqual([]);
		await type(v, 'input[name="wa-token"]', TOKEN);
		await click(v, "[data-wa-save]");
		await waitFor(v, `[...document.querySelectorAll("dialog .btn")].some(b => b.textContent === "바꾸기")`);
		expect(await ev<string>(v, `document.querySelector("dialog").textContent`)).toContain("Tailscale");
		await confirm(v, "바꾸기");
		await waitFor(v, `document.querySelector("[data-wa-token-set]") && document.querySelector("[data-wa-tunnel]")`);
		expect(puts).toEqual([{ mode: "cloudflare", hostname: "dotz.example.com", token: TOKEN }]);
		const s = await ev<{ html: string; tunnel: string; token: string; devices: string }>(v, `({ html: document.querySelector("#webaccess").innerHTML, tunnel: document.querySelector("[data-wa-tunnel]").dataset.waTunnel, token: document.querySelector('input[name="wa-token"]').value, devices: document.querySelector("[data-wa-devices]").textContent })`);
		expect(s.tunnel).toBe("running");
		expect(s.token).toBe("");
		expect(s.html).not.toContain(TOKEN);
		expect(s.devices).toContain("0대");
		await click(v, "[data-wa-devices]");
		await waitFor(v, `current === "devices"`);
	});

	test("switching back to Tailscale sends only the mode, with no confirm", async () => {
		reset();
		wa = { ...wa, mode: "cloudflare", hostname: "dotz.example.com", token_set: true, tunnel: { state: "running" } };
		const v = await open();
		await click(v, '#webaccess .seg [data-v="tailscale"]');
		await waitFor(v, `!document.querySelector("[data-wa-save]").disabled`);
		await click(v, "[data-wa-save]");
		await waitFor(v, `WA.data.mode === "tailscale"`);
		expect(puts).toEqual([{ mode: "tailscale" }]);
		expect(await ev(v, `document.querySelector("dialog[open]")`)).toBeNull();
		expect(await ev(v, `document.querySelector("[data-wa-tunnel]")`)).toBeNull();
	});

	test("a missing cloudflared shows the install hint", async () => {
		reset();
		found = false;
		wa = { ...wa, mode: "cloudflare", hostname: "dotz.example.com", token_set: true, tunnel: { state: "error", error: "cloudflared를 찾을 수 없습니다" } };
		const v = await open();
		expect(await ev<string>(v, `document.querySelector("[data-wa-tunnel]").textContent`)).toContain("brew install cloudflared");
		found = true;
	});

	test("screenshots: Cloudflare on, desktop and phone, light and dark", async () => {
		for (const [name, w, h] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
			for (const theme of ["light", "dark"] as const) {
				reset();
				wa = { ...wa, mode: "cloudflare", hostname: "dotz.example.com", team: "myteam", aud: "a".repeat(64), token_set: true, tunnel: { state: "running" }, devices: 2 };
				const v = await open(w, h, theme);
				await waitFor(v, `document.querySelector("[data-wa-tunnel]")`);
				await Bun.write(`${SHOTS}/web-access-${name}-${theme}.png`, await v.screenshot());
			}
		}
		for (const d of ["desktop", "phone"]) for (const t of ["light", "dark"]) expect(await Bun.file(`${SHOTS}/web-access-${d}-${t}.png`).exists()).toBe(true);
	}, 60_000);
});
