import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ev, fakeHub, json, run, waitFor, type View } from "./test-web.ts";
import { setAppLang } from "./webapp.ts";

const SHOTS = process.env.MAIL_UI_SHOTS ?? "";
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const SIX = ["mail-read", "mail-unread", "mail-archive", "mail-fyi", "mail-move", "mail-trash"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
type Mail = { key: string; subject: string; from: string; box: string; read: boolean; at: string; reply?: "needs"; dir?: "out"; archived?: boolean };
const BOXES = { mail: [{ id: "base", name: "일반", icon: "mail", base: true }, { id: "b-pay", name: "결제", icon: "mail", mode: "ask" }], work: [{ id: "base", name: "일반", icon: "mail", base: true }] };
const fresh = (): Mail[] => [
	{ key: "p-1", subject: "답장이 필요한 개인 메일", from: "Kim <kim@example.com>", box: "base", read: false, at: ago(1), reply: "needs" },
	{ key: "p-2", subject: "읽은 개인 메일", from: "Lee <lee@example.com>", box: "base", read: true, at: ago(2) },
	{ key: "p-3", subject: "결제 안내", from: "Shop <shop@example.com>", box: "b-pay", read: false, at: ago(3) },
	{ key: "p-out", subject: "Re: 개인 메일 답장", from: "me@example.com", box: "base", read: true, at: ago(4), dir: "out" },
	{ key: "p-arch", subject: "보관한 개인 메일", from: "Park <park@example.com>", box: "base", read: true, at: ago(5), archived: true },
	{ key: "w-1", subject: "답장이 필요한 회사 메일", from: "Choi <choi@work.example.com>", box: "base", read: false, at: ago(6), reply: "needs" },
	{ key: "w-2", subject: "읽은 회사 메일", from: "Han <han@work.example.com>", box: "base", read: true, at: ago(7) },
];
let mails: Mail[] = fresh();
let posts: { path: string; body: unknown }[] = [];
let gate: { p: Promise<void>; open: () => void } | null = null;

const card = (m: Mail) => ({ subject: m.subject, from: m.from, source: "acme", at: m.at, summary: "요약이에요", read: m.read, archived: !!m.archived, starred: false, can: CAN, box: m.box, reply: m.reply, dir: m.dir });
const mine = (inst: string) => mails.filter(m => (inst === "mail" ? !m.key.startsWith("w-") : m.key.startsWith("w-")));
const item = (inst: string) => ({ key: inst, app: "mail", label: inst === "mail" ? "개인 메일" : "회사 메일", icon: "mail", kind: "app", conv: inst === "mail" ? ["mail:"] : ["mail:w-"], ...(inst === "mail" ? { convNot: ["mail:w-"] } : {}),
	state: "connected", notices: [], unread: mine(inst).filter(m => !m.read).length, needs: { drafts: 0, unread: mine(inst).filter(m => !m.read).length, sentToday: 0, unreplied: 0 },
	boxes: inst === "mail" ? BOXES.mail : BOXES.work, account: inst === "mail" ? "me@example.com" : "me@work.example.com" });

const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [item("mail"), item("mail-2")], available: [] });
		if (p === "/api/conversations") return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: m.read || m.dir ? 0 : 1, read: null, mail: card(m), last: { ts: m.at, text: m.subject, from: "bot" } })) });
		if (p === "/api/history") {
			const t = url.searchParams.get("target") ?? "", m = mails.find(x => `mail:${x.key}` === t);
			return json({ target: t, events: m ? [{ kind: "mail", ts: m.at, conv: t, target: t, mail: m.key, subject: m.subject, from: m.from, dir: m.dir, source: "acme", html: false, text: `[mail] ${m.subject}\n\n요약이에요\n\n원문\n안녕하세요.` }] : [] });
		}
		if (req.method === "POST" && (p.startsWith("/api/mail") || p.startsWith("/api/mailbox"))) {
			const body = (await req.json()) as { keys?: string[] };
			posts.push({ path: p, body });
			if (gate) await gate.p;
			return json({ ok: true, results: (body.keys ?? []).map(key => ({ key, ok: true, synced: true })), synced: true });
		}
		return undefined;
	},
});
afterAll(() => hub.stop());
afterEach(() => setAppLang("ko"));
beforeEach(() => { gate?.open(); gate = null; mails = fresh(); posts = []; });

const rowJs = (key: string) => `document.querySelector('#mon-tl > .mr[data-t="mail:${key}"]')`;
const slot = (k: string) => `document.querySelector('#mbox-bar [data-k="${k}"]')`;
const toastText = (v: View) => ev<string | null>(v, `document.querySelector(".snack")?.textContent ?? null`);
const shot = async (v: View, name: string) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await waitFor(v, `!document.getAnimations().some(a => a.playState === "running" && a.effect.getTiming().iterations !== Infinity)`);
	await Bun.write(`${SHOTS}/${name}.png`, await v.screenshot());
};
async function open(width: number, height = 900): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `NT.loaded && NM.loaded && INTG.items.length === 2 && CONV.has("mail:p-1")`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelector("#mon-tl > .mr") && document.querySelector("#mbox-bar")`);
	return v;
}
const only = async (v: View, keys: string[]) => {
	await run(v, `document.querySelector("#mbox-bar .mbox-x")?.click(); ${keys.map(k => `${rowJs(k)}.querySelector(".mr-chk").click();`).join(" ")}`);
	await waitFor(v, `document.querySelector("#mbox-bar.on") && document.querySelectorAll("#mon-tl .mr-chk:checked").length === ${keys.length}`);
};
const place = async (v: View, name: string) => {
	await run(v, `document.querySelector('#mon-tl [data-filter="${name}"]').click()`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-place [aria-selected="true"]')?.dataset.filter === ${JSON.stringify(name)}`);
};
const slots = (v: View) => ev<[string, number][]>(v, `[...document.querySelectorAll("#mbox-bar .mbox-b[data-k]")].map(b => [b.dataset.k, Math.round(b.getBoundingClientRect().left)]).sort((p, q) => p[1] - q[1])`);
const fits = (v: View) => ev<{ inside: boolean; oneLine: boolean; noScroll: boolean; count: string; countShown: boolean; xShown: boolean; barW: number; usedW: number }>(v, `(() => {
	const b = document.querySelector("#mbox-bar"), r = b.getBoundingClientRect(), kids = [...b.children].map(c => c.getBoundingClientRect()), n = b.querySelector(".mbox-n"), nr = n.getBoundingClientRect(), x = b.querySelector(".mbox-x").getBoundingClientRect();
	const within = q => q.width > 0 && q.left >= r.left - 0.5 && q.right <= r.right + 0.5;
	return { inside: kids.every(within), oneLine: new Set(kids.map(q => Math.round(q.top + q.height / 2))).size === 1, noScroll: b.scrollWidth <= b.clientWidth, count: n.textContent, countShown: within(nr) && nr.width >= n.scrollWidth - 0.5 && getComputedStyle(n).clipPath === "none", xShown: within(x),
		barW: Math.round(r.width), usedW: Math.round(kids[kids.length - 1].right - kids[0].left) }; })()`);

describe("one bar for every account", () => {
	for (const [width, height] of [[390, 844], [1280, 800]] as const) {
		test(`at ${width} a two-mailbox and a one-mailbox account, with and without a mail that owes a reply, show the same six slots in the same place`, async () => {
			const v = await open(width, height);
			const seen: [string, [string, number][]][] = [];
			for (const [key, name] of [["p-1", "two-boxes-owed"], ["p-2", "two-boxes"], ["w-1", "one-box-owed"], ["w-2", "one-box"]] as const) {
				await only(v, [key]);
				seen.push([key, await slots(v)]);
				await shot(v, `bar-${width}-${name}`);
			}
			for (const [, s] of seen) expect(s.map(x => x[0])).toEqual(SIX);
			expect(new Set(seen.map(([, s]) => JSON.stringify(s))).size).toBe(1);
		}, 60_000);
	}

	for (const [width, height] of [[390, 844], [1280, 800]] as const) {
		test(`at ${width} in 보관 the 보관 slot gives the mail back and every slot after it stays where it was in the inbox`, async () => {
			const v = await open(width, height);
			await only(v, ["p-2"]);
			const inbox = await slots(v);
			await place(v, "archived");
			await only(v, ["p-arch"]);
			const archived = await slots(v);
			expect(archived.map(x => x[0])).toEqual(SIX.map(k => (k === "mail-archive" ? "mail-unarchive" : k)));
			expect(archived.map(x => x[1])).toEqual(inbox.map(x => x[1]));
		}, 30_000);
	}
});

describe("a slot that cannot act", () => {
	const tap = async (v: View, k: string) => { await run(v, `document.querySelectorAll(".snack").forEach(n => n.remove()); ${slot(k)}.click()`); await waitFor(v, `document.querySelector(".snack")`); return toastText(v); };

	test("stays in place, can be focused, says why in one line when tapped, and sends nothing", async () => {
		const v = await open(1280, 800);
		await only(v, ["w-2"]);
		expect(await ev<[boolean, boolean]>(v, `(() => { const b = ${slot("mail-move")}; b.focus(); return [b.disabled, document.activeElement === b]; })()`)).toEqual([false, true]);
		expect(await tap(v, "mail-move")).toBe("이 계정은 메일함이 하나라 옮길 곳이 없어요");
		expect(await ev<boolean>(v, `!!document.querySelector(".menu, .msheet")`)).toBe(false);
		expect(await tap(v, "mail-fyi")).toBe("답장이 필요한 메일이 없어요");
		expect(await tap(v, "mail-read")).toBe("이미 읽은 메일이에요");
		await shot(v, "bar-1280-dimmed-toast");
		await only(v, ["w-2", "p-2"]);
		expect(await tap(v, "mail-move")).toBe("한 계정의 메일만 골라야 옮길 수 있어요");
		await place(v, "sent");
		await only(v, ["p-out"]);
		expect(await tap(v, "mail-read")).toBe("보낸 메일은 읽음 표시가 없어요");
		expect(await tap(v, "mail-unread")).toBe("보낸 메일은 읽음 표시가 없어요");
		expect(await tap(v, "mail-archive")).toBe("보낸 메일은 보관하지 않아요");
		expect(posts).toEqual([]);
	}, 30_000);

	test("a slot that can act still acts: 옮기기 of a two-mailbox account opens its boxes", async () => {
		const v = await open(1280, 800);
		await only(v, ["p-2"]);
		await run(v, `${slot("mail-move")}.click()`);
		await waitFor(v, `document.querySelector(".menu .mi")`);
		expect(await ev<string[]>(v, `[...document.querySelectorAll(".menu .mi .ml")].map(b => b.firstChild.textContent)`)).toEqual(["결제"]);
	}, 30_000);

	test("looks different from a slot that waits for the hub", async () => {
		const v = await open(1280, 800);
		const { promise, resolve } = Promise.withResolvers<void>();
		gate = { p: promise, open: resolve };
		await only(v, ["w-1"]);
		await run(v, `${slot("mail-archive")}.click()`);
		await waitFor(v, `${slot("mail-archive")}.getAttribute("aria-busy") === "true"`);
		const look = (k: string) => ev<string[]>(v, `(() => { const s = getComputedStyle(${slot(k)}); return [s.color, s.opacity, s.backgroundColor]; })()`);
		expect(await look("mail-move")).not.toEqual(await look("mail-archive"));
		gate.open();
	}, 30_000);
});

const SWEEP = [1180, 1190, 1200, 1210, 1220, 1230, 1237, 1238, 1240, 1250, 1260, 1270, 1280, 1283, 1284, 1290];
const WORDS_FROM = { ko: 594, en: 640 };

describe("the bar fits", () => {
	for (const lang of ["ko", "en"] as const) {
		for (const tab of ["all", "archived"] as const) {
			test(`${lang}, ${tab} tab: at every window from ${SWEEP[0]} to ${SWEEP[SWEEP.length - 1]} the bar is on one line with nothing cut or scrolled, and the words show once the list is ${WORDS_FROM[lang]}px wide`, async () => {
				setAppLang(lang);
				const v = await open(1280, 800);
				if (tab === "archived") await place(v, "archived");
				await run(v, `document.querySelector("#mbox-bar .mbox-all").click()`);
				await waitFor(v, `document.querySelector("#mbox-bar.on")`);
				const bad: string[] = [], seen: string[] = [];
				for (const w of SWEEP) {
					await v.resize(w, 800);
					await waitFor(v, `window.innerWidth === ${w}`);
					const got = await fits(v), words = await ev<boolean>(v, `[...document.querySelectorAll("#mbox-bar .mbox-b[data-k] .mbox-bt")].every(t => t.getBoundingClientRect().width > 0)`);
					seen.push(`${w}:${got.barW}/${got.usedW}${words ? "w" : ""}`);
					if (![got.inside, got.oneLine, got.noScroll, got.countShown, got.xShown].every(Boolean) || words !== got.barW >= WORDS_FROM[lang]) bad.push(`${w}: bar ${got.barW}px, used ${got.usedW}px, words ${words}, inside ${got.inside}, scroll ${!got.noScroll}`);
					if ([1238, 1280, 1284].includes(w)) await shot(v, `bar-${lang}-${tab}-${w}`);
				}
				console.info(`${lang} ${tab}: ${seen.join(" ")}`);
				expect(bad).toEqual([]);
			}, 60_000);
		}
	}

	for (const width of [360, 390]) {
		test(`at ${width} the ×, the six icons and the count stand on one line inside the bar`, async () => {
			const v = await open(width, 844);
			await run(v, `document.querySelector("#mbox-bar .mbox-all").click()`);
			await waitFor(v, `document.querySelector("#mbox-bar.on")`);
			const got = await fits(v);
			console.info(`bar at ${width}: ${got.usedW}px used of ${got.barW}px`);
			expect({ ...got, barW: 0, usedW: 0 }).toEqual({ inside: true, oneLine: true, noScroll: true, count: "5개", countShown: true, xShown: true, barW: 0, usedW: 0 });
			if (width === 390) await shot(v, "bar-390-all");
		}, 30_000);
	}

	test("at 1280 with every mail selected the words show and nothing is cut", async () => {
		const v = await open(1280, 800);
		await run(v, `document.querySelector("#mbox-bar .mbox-all").click()`);
		await waitFor(v, `document.querySelector("#mbox-bar.on")`);
		const got = await fits(v);
		console.info(`bar at 1280: ${got.usedW}px used of ${got.barW}px`);
		expect({ ...got, barW: 0, usedW: 0 }).toEqual({ inside: true, oneLine: true, noScroll: true, count: "5개", countShown: true, xShown: true, barW: 0, usedW: 0 });
		expect(await ev<boolean>(v, `[...document.querySelectorAll("#mbox-bar .mbox-b[data-k] .mbox-bt")].every(t => t.getBoundingClientRect().width > 0)`)).toBe(true);
		await shot(v, "bar-1280-all");
	}, 30_000);

	for (const width of [640, 760, 900, 1024, 1100, 1180]) {
		test(`at ${width} the words show only on a list ${WORDS_FROM.ko}px or wider, and either way nothing is cut`, async () => {
			const v = await open(width, 800);
			await run(v, `document.querySelector("#mbox-bar .mbox-all").click()`);
			await waitFor(v, `document.querySelector("#mbox-bar.on")`);
			const got = await fits(v), words = await ev<boolean>(v, `[...document.querySelectorAll("#mbox-bar .mbox-b[data-k] .mbox-bt")].every(t => t.getBoundingClientRect().width > 0)`);
			console.info(`bar at ${width}: ${got.usedW}px used of ${got.barW}px, words ${words}`);
			expect([got.inside, got.oneLine, got.noScroll, got.countShown, got.xShown, words]).toEqual([true, true, true, true, true, got.barW >= WORDS_FROM.ko]);
		}, 30_000);
	}
});

describe("one name, one icon", () => {
	test("the open mail's bar draws each action with the list bar's icon and name, and 보관 is the name of the 보관 tab", async () => {
		const v = await open(1280, 800);
		await only(v, ["p-1"]);
		const listBar = await ev<Record<string, [string, string]>>(v, `Object.fromEntries([...document.querySelectorAll("#mbox-bar .mbox-b[data-k]")].map(b => [b.dataset.k.slice(5), [b.getAttribute("aria-label"), b.querySelector("svg").innerHTML]]))`);
		const tab = await ev<string>(v, `document.querySelector('#mon-tl [data-filter="archived"]').firstChild.textContent`);
		expect(listBar.archive![0]).toBe(tab);
		await run(v, `MBOX.sel.clear(); ${rowJs("p-1")}.click()`);
		await waitFor(v, `document.querySelector('#tl .mtop [data-k="mail-open-read"]')`);
		await shot(v, "open-mail-bar-1280");
		const openBar = await ev<Record<string, [string, string]>>(v, `Object.fromEntries([...document.querySelectorAll("#tl .mtop [data-k]")].map(b => [b.dataset.k.slice(10), [b.getAttribute("aria-label"), b.querySelector("svg").innerHTML]]))`);
		for (const a of ["read", "archive", "trash"]) expect(openBar[a]).toEqual(listBar[a]!);
		expect(await ev<string>(v, `[...document.querySelectorAll("#tl .mtop [data-k]")].pop().dataset.k`)).toBe("mail-open-trash");
	}, 30_000);
});
