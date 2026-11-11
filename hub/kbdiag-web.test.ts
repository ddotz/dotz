import { afterAll, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

// The input diagnostic (web/js/34-input-diag.js): off until the 표시 switch or ?kbdiag=1 turns it on; then every blur of a text field leaves one entry
// that names the field and what led to the blur, and never the typed text.
const SECRET = "비밀문장-48213";
const hub = fakeHub({ stream: "fake" });
const view = await hub.view({ width: 390, height: 844 });
afterAll(() => hub.stop());
const { waitFor, ev, run } = on(view);

type Entry = { kind: string; field: { sel: string; tag: string; id: string }; connected: boolean; recent: { type: string; on: string }[]; stack: string[]; vis: string; after?: { connected: boolean; activeIsField: boolean } };
const stored = () => view.evaluate(`localStorage.getItem("dotz-kbdiag-log")`) as Promise<string | null>;

async function open(path = "/") {
	const opened = hub.nextStream();
	await view.navigate(`${hub.origin}${path}`);
	await waitFor(`typeof S === "object" && S`);
	await opened;
}
async function typeInComposer() {
	await run(`go("chat", "main"); ta.value = ""; saveDraft(); autosize()`);
	await waitFor(`!document.querySelector("#v-chat").hidden`);
	await view.click("#text");
	await waitFor(`document.activeElement === document.querySelector("#text")`);
	await view.type(SECRET);
	await waitFor(`document.querySelector("#text").value === ${JSON.stringify(SECRET)}`);
}

test("off by default: leaving a typed-in field writes nothing", async () => {
	await open();
	await run(`localStorage.clear()`);
	await open();
	await typeInComposer();
	await run(`document.querySelector("#text").blur()`);
	expect(await stored()).toBeNull();
	expect(await view.evaluate(`localStorage.getItem("dotz-kbdiag")`)).toBeNull();
});

test("on from the 표시 switch: a blur and a removal are recorded without the typed text, and 복사 and 지우기 work on the buffer", async () => {
	await open();
	await run(`localStorage.clear(); go("display")`);
	await waitFor(`current === "display" && document.querySelector('[data-k="kbdiag"]')`);
	expect(await view.evaluate(`document.querySelector('[data-k="kbdiag-copy"]') === null`)).toBe(true);
	await view.click('[data-k="kbdiag"]');
	await waitFor(`document.querySelector('[data-k="kbdiag-copy"]')`);
	expect(await view.evaluate(`localStorage.getItem("dotz-kbdiag")`)).toBe("1");

	await typeInComposer();
	await run(`document.querySelector("#text").blur()`);
	await waitFor(`(JSON.parse(localStorage.getItem("dotz-kbdiag-log") || "[]")[0] || {}).after`);
	await run(`document.querySelector("#text").focus()`);
	await run(`document.querySelector("#text").remove()`);
	await waitFor(`JSON.parse(localStorage.getItem("dotz-kbdiag-log") || "[]").length >= 2 && JSON.parse(localStorage.getItem("dotz-kbdiag-log")).every(e => e.after)`);

	const raw = (await stored()) as string;
	expect(raw).not.toContain(SECRET);
	const log = JSON.parse(raw) as Entry[];
	expect(log[0]).toMatchObject({ kind: "blur", connected: true, vis: "visible", field: { tag: "textarea", id: "text" } });
	expect(log[0]!.after).toMatchObject({ connected: true, activeIsField: false });
	expect(log[0]!.recent.map(r => r.type)).toContain("input");
	expect(log[0]!.stack.length).toBeGreaterThan(0);
	expect(log[1]!.after).toMatchObject({ connected: false });
	expect(log.some(e => e.kind === "removed" || e.connected === false)).toBe(true);

	await run(`go("display"); window.copyText = async t => { window.__copied = t; return true; }`);
	await waitFor(`current === "display" && document.querySelector('[data-k="kbdiag-copy"]')`);
	await view.click('[data-k="kbdiag-copy"]');
	await waitFor(`window.__copied`);
	const copied = JSON.parse((await ev<string>(`window.__copied`)) as string) as { entries: Entry[] };
	expect(copied.entries.length).toBe(log.length);
	expect(JSON.stringify(copied)).not.toContain(SECRET);

	await view.click('[data-k="kbdiag-clear"]');
	await waitFor(`localStorage.getItem("dotz-kbdiag-log") === null`);
});

test("the buffer keeps the newest 200 entries; ?kbdiag=1 turns it on and ?kbdiag=0 off", async () => {
	await open("/?kbdiag=1");
	expect(await view.evaluate(`localStorage.getItem("dotz-kbdiag")`)).toBe("1");
	await run(`for (let i = 0; i < 205; i++) kbdPush({ n: i })`);
	expect(await ev<number[]>(`JSON.parse(localStorage.getItem("dotz-kbdiag-log")).map(e => e.n).filter((n, i, a) => i === 0 || i === a.length - 1)`)).toEqual([5, 204]);
	await open("/?kbdiag=0");
	expect(await view.evaluate(`localStorage.getItem("dotz-kbdiag")`)).toBeNull();
});

test("표시: both values of 대화 탭 describe themselves in the same number of lines, so the rows below do not move", async () => {
	await open();
	await run(`localStorage.clear(); chatTabModeSet("main"); go("display")`);
	await waitFor(`current === "display" && document.querySelector('[data-k="kbdiag"]')`);
	const heights = `[...document.querySelectorAll("#display .li")].map(li => Math.round(li.getBoundingClientRect().height))`;
	const main = await ev<number[]>(heights);
	await run(`chatTabModeSet("last"); renderSettings()`);
	await waitFor(`chatTabMode() === "last" && document.querySelector('[data-k="kbdiag"]')`);
	expect(await ev<number[]>(heights)).toEqual(main);
});
