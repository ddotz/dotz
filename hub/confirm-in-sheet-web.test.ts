import { afterAll, describe, expect, test } from "bun:test";
import { fakeHub, on } from "./test-web.ts";

// A confirm asked while a sheet is open shows its question inside that sheet and gives the sheet back after the answer (docs/ui-spec.md 대화창).
const hub = fakeHub({ stream: "fake" });
afterAll(() => hub.stop());
const view = await hub.view({ width: 390, height: 844 });
const { waitFor } = on(view);
const opened = hub.nextStream();
await view.navigate(`${hub.origin}/`);
await opened;
await waitFor(`typeof dialog === "function" && typeof fsOpen === "function" && S && NT.loaded`);

const OPEN_SHEET: Record<string, string> = {
	dialog: `dialog({ title: "시트", body: el("p", { text: "본문" }), actions: [{ label: "닫기", onclick: c => c() }] })`,
	overlay: `(() => { const h = fsOpen({ label: "시트" }); h.box.append(fsHead([el("h2", { text: "시트" })], { close: () => h.close() }), el("div", { class: "fs-body" }, el("p", { text: "본문" }))); return h; })()`,
};
const STATE = `JSON.stringify({ dialogs: document.querySelectorAll("dialog[open]:not([data-leaving])").length, text: (document.querySelector("dialog.fs-card[open], section.fs-card") || {}).innerText || "" })`;
const state = async () => JSON.parse((await view.evaluate(STATE)) as string) as { dialogs: number; text: string };
const press = (label: string) => view.evaluate(`(() => { const b = [...document.querySelectorAll("dialog.fs-card[open] button, section.fs-card button, dialog.cf[open] button")].find(x => x.textContent.trim() === ${JSON.stringify(label)}); b.click(); return 0; })()`);

for (const [kind, open] of Object.entries(OPEN_SHEET)) {
	describe(`a confirm asked inside a ${kind} sheet`, () => {
		test("opens no second dialog, then gives the sheet back after either answer", async () => {
			for (const [button, answer] of [["취소", false], ["삭제", true]] as const) {
				await view.evaluate(`(window.__sheet = ${open}, window.__answer = undefined, ask("삭제할까요?", "되돌릴 수 없어요", "삭제", true).then(v => { window.__answer = v; }), 0)`);
				await waitFor(`document.body.textContent.includes("되돌릴 수 없어요")`);
				const during = await state();
				expect(during.dialogs).toBeLessThanOrEqual(kind === "dialog" ? 1 : 0);
				expect(during.text).toContain("삭제할까요?");
				expect(during.text).not.toContain("본문");
				await press(button);
				await waitFor(`window.__answer !== undefined`);
				expect(await view.evaluate(`window.__answer`)).toBe(answer);
				await waitFor(`(document.querySelector("dialog.fs-card[open], section.fs-card") || { innerText: "" }).innerText.includes("본문")`);
				const after = await state();
				expect(after.dialogs).toBeLessThanOrEqual(kind === "dialog" ? 1 : 0);
				expect(after.text).not.toContain("삭제할까요?");
				await view.evaluate(`(window.__sheet.close(), 0)`);
				await waitFor(`!document.querySelector("dialog[open], section.fs-card")`);
			}
		}, 30_000);
	});
}

// Where the focus lands when a window opens: a mouse or touch open leaves it on the window (no ring on a button), the keyboard's goes to the first control.
describe("the first focus of a window", () => {
	const OPENERS: Record<string, string> = {
		confirm: `ask("삭제할까요?", "되돌릴 수 없어요", "삭제", true)`,
		sheet: `(window.__sheet = ${OPEN_SHEET.overlay}, ask("삭제할까요?", "되돌릴 수 없어요", "삭제", true))`,
	};
	for (const [kind, open] of Object.entries(OPENERS)) {
		test(`a ${kind} opened by a pointer holds the focus itself; by a key, its first button does`, async () => {
			for (const how of ["pointer", "key"] as const) {
				await view.evaluate(`(document.dispatchEvent(new Event(${how === "pointer" ? '"pointerdown"' : '"keydown"'})), ${open}, 0)`);
				await waitFor(`document.body.textContent.includes("되돌릴 수 없어요")`);
				const at = JSON.parse((await view.evaluate(`JSON.stringify({ button: document.activeElement.tagName === "BUTTON", host: document.activeElement.matches("dialog, .fs-card"), inside: !!document.activeElement.closest("dialog, .fs-card") })`)) as string);
				expect(at).toEqual(how === "pointer" ? { button: false, host: true, inside: true } : { button: true, host: false, inside: true });
				await press("취소");
				await view.evaluate(`(window.__sheet && window.__sheet.close(), window.__sheet = null, 0)`);
				await waitFor(`!document.querySelector("dialog[open], section.fs-card")`);
			}
		}, 30_000);
	}
});
