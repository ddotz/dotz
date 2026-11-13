import { afterAll, beforeEach, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

const SECRET = "비밀문장-48213";
const hub = fakeHub({ stream: "fake" });
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

type Posted = { app: string; entries: { n: number; kind: string; app: string; field: { sel: string; tag: string }; vh: { before: number; after: number }; recent: { type: string }[]; stack: string[] }[] };
const posts = () => ev<Posted[]>(`window.__posts`);
const step = async (n: number) => waitFor(`window.__posts.length >= ${n}`);

beforeEach(async () => {
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}/`);
	await waitFor(`typeof S === "object" && S`);
	await opened;
	await run(`localStorage.clear(); go("chat", "main"); ta.value = ""; autosize();
		window.__posts = []; const real = window.fetch; window.fetch = (u, o) => String(u).includes("/api/input-diag") ? (window.__posts.push(JSON.parse(o.body)), Promise.resolve(new Response("{}", { status: 201 }))) : real(u, o);
		kbdAuto = true; kbdWatch(); kbdPosts = []`);
});

const leave = async () => {
	await run(`kbdTapAt = -1e9; ta.focus()`);
	await waitFor(`document.activeElement === ta`);
	await run(`ta.blur()`);
};

test("a phone posts one entry when the field loses focus by itself: its name, what led up to it, the viewport, the build, never the typed text", async () => {
	await view.click("#text");
	await waitFor(`document.activeElement === ta`);
	await view.type(SECRET);
	await run(`kbdTapAt = -1e9; ta.blur()`);
	await step(1);
	const [p] = await posts();
	expect(p!.entries).toHaveLength(1);
	expect(p!.entries[0]).toMatchObject({ kind: "blur", field: { sel: expect.stringContaining("textarea#text"), tag: "textarea" }, vh: { before: expect.any(Number), after: expect.any(Number) } });
	expect(p!.entries[0]!.recent.some(r => r.type === "input")).toBe(true);
	expect(typeof p!.app).toBe("string");
	expect(JSON.stringify(p)).not.toContain(SECRET);
});

test("a tap just before, or a desktop pointer, is no report; the same blur afterwards is", async () => {
	await run(`ta.focus(); document.dispatchEvent(new Event("pointerdown", { bubbles: true })); ta.blur()`);
	await run(`kbdAuto = false; kbdWatch()`);
	await leave();
	await run(`kbdAuto = true; kbdWatch()`);
	await leave();
	await step(1);
	expect((await posts()).map(p => p.entries.length)).toEqual([1]);
	expect(await ev<number>(`kbdPosts.length`)).toBe(1);
});

test("a field taken out of the page is reported as removed", async () => {
	await run(`const f = document.createElement("input"); f.id = "gone"; document.body.append(f); kbdTapAt = -1e9; f.focus()`);
	await waitFor(`document.activeElement.id === "gone"`);
	await run(`document.querySelector("#gone").remove()`);
	await waitFor(`window.__posts.some(p => p.entries.some(e => e.kind === "removed"))`);
	const removed = (await posts()).flatMap(p => p.entries).filter(e => e.kind === "removed");
	expect(removed).toHaveLength(1);
	expect(removed[0]).toMatchObject({ field: { tag: "input" } });
});

test("at most three posts a minute, and a failed post is dropped without an error", async () => {
	for (let i = 0; i < 4; i++) await leave();
	await step(3);
	expect(await ev<number>(`kbdPosts.length`)).toBe(3);
	await run(`window.fetch = () => Promise.reject(new TypeError("offline"))`);
	await run(`kbdPost([{}], true).then(v => { window.__sent = v; })`);
	await waitFor(`window.__sent === false`);
});

test("the ring a phone already has goes up once", async () => {
	await run(`localStorage.setItem("dotz-kbdiag-log", JSON.stringify([{ n: 1, field: { tag: "textarea" } }, { n: 2, field: { tag: "input" } }])); kbdBuf = null; kbdUploadRing()`);
	await step(1);
	expect((await posts())[0]!.entries.map(e => e.n)).toEqual([1, 2]);
	await waitFor(`localStorage.getItem("dotz-kbdiag-sent") === "1"`);
	await run(`kbdUploadRing()`);
	expect((await posts()).length).toBe(1);
});
