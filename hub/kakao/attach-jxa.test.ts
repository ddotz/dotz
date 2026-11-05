// The file send decisions of attach.jxa.js itself: the script runs against a fake KakaoTalk (windows, 편집 menu, dialog) and a fake pasteboard
// (jxa.fixture.ts), so what it pastes, presses and leaves on the clipboard is observable. Nothing here touches KakaoTalk.
import { expect, test } from "bun:test";
import { loadJxa } from "./jxa.fixture.ts";

const button = (name: string, onPress: () => void = () => {}) => ({ name: () => name, actions: { byName: () => ({ perform: onPress }) } });
// An element collection as JXA has it: called for its members, or asked for one attribute of all of them.
const collection = (members: unknown[], attrs: Record<string, () => unknown[]>) => new Proxy(() => members, { get: (_t, k) => attrs[String(k)] });

function chatWindow(title: string, opts: { self?: boolean; value?: string } = {}) {
	const input = { value: () => opts.value ?? "", placeholderValue: () => "", focused: false };
	const sheetList: object[] = [];
	const buttons = collection([button("전송")], { name: () => ["전송"] });
	const uiElements = collection([], { role: () => ["AXStaticText"], name: () => [opts.self ? "나와의 채팅" : ""], value: () => [""] });
	return { name: () => title, id: () => title, subrole: () => "AXStandardWindow", scrollAreas: () => [{ textAreas: () => [input] }], sheets: () => sheetList, buttons, uiElements, sheetList };
}

function world(opts: { paste: (w: ReturnType<typeof scene>) => void; extra?: ReturnType<typeof chatWindow>[]; self?: ReturnType<typeof chatWindow> }) {
	const w = scene(opts);
	const jxa = loadJxa({ systemEvents: { processes: { whose: () => () => [w.proc] } }, objc: w.objc });
	return { ...w, attach: () => jxa.attachFile("나", "/x/a.png") };
}

function scene(opts: { paste: (w: any) => void; extra?: ReturnType<typeof chatWindow>[]; self?: ReturnType<typeof chatWindow> }) {
	const self = opts.self ?? chatWindow("나", { self: true });
	const main = { name: () => "카카오톡", id: () => "Main Window", subrole: () => "AXStandardWindow", scrollAreas: () => [], sheets: () => [], buttons: () => [] };
	const windows: any[] = [main, self, ...(opts.extra ?? [])];
	const log: string[] = [];
	const pasteItem = { name: () => "붙여넣기", actions: { byName: () => ({ perform: () => (log.push("paste"), opts.paste(state)) }) } };
	const proc = {
		windows: () => windows,
		menuBars: [{ menuBarItems: () => [{ name: () => "편집", menus: [{ menuItems: () => [pasteItem] }] }] }],
		set frontmost(_v: boolean) {
			log.push("frontmost");
		},
	};
	const item = (data: string) => ({ types: { count: 1, objectAtIndex: () => "public.utf8-plain-text" }, dataForType: () => ({ isNil: () => false, data }) });
	const list = (values: unknown[]) => ({ values, get count() { return values.length; }, addObject: (v: unknown) => void values.push(v), objectAtIndex: (i: number) => values[i], isNil: () => false });
	const pb = {
		items: [item("owner's copy")] as any[],
		changeCount: 1,
		get clearContents() {
			pb.items = [];
			return ++pb.changeCount;
		},
		get pasteboardItems() {
			return list(pb.items);
		},
		writeObjects: (l: { values: unknown[] }) => ((pb.items = [...l.values]), pb.changeCount++, true),
	};
	const objc = {
		NSPasteboard: { generalPasteboard: pb },
		NSURL: { fileURLWithPath: (p: string) => ({ url: p }) },
		get NSMutableArray() {
			return { array: list([]) };
		},
		NSPasteboardItem: { alloc: { get init() { return { saved: [] as string[], setDataForType(d: { data: string }) { this.saved.push(d.data); } }; } } },
	};
	const state = { self, windows, log, proc, pb, objc, clipboard: () => JSON.stringify(pb.items.map(i => i.saved ?? i.url ?? "owner's copy")) };
	return state;
}

const sheet = (s: ReturnType<typeof scene>, onSend: () => void) => {
	const d = { buttons: () => [button("전송", () => (s.log.push("send"), onSend())), button("취소", () => (s.log.push("cancel"), s.self.sheetList.pop()))] };
	s.self.sheetList.push(d);
};
const owners = '[["owner\'s copy"]]';

test("the dialog of the only chat window is pressed once, nothing comes forward, and the clipboard is the owner's again", () => {
	const s = world({ paste: w => sheet(w, () => w.self.sheetList.pop()) });
	expect(s.attach()).toEqual({ ok: true, pressed: true });
	expect(s.log).toEqual(["paste", "send"]);
	expect(s.clipboard()).toBe(owners);
});

test("another chat window open refuses before the clipboard or the paste is touched", () => {
	const s = world({ paste: () => {}, extra: [chatWindow("친구")] });
	expect(s.attach()).toMatchObject({ ok: false, why: "other_window" });
	expect(s.log).toEqual([]);
	expect(s.pb.changeCount).toBe(1);
});

test("a window of the right title that does not show it is the 나와의 채팅 refuses", () => {
	const s = world({ paste: () => {}, self: chatWindow("나") });
	expect(s.attach()).toMatchObject({ ok: false, why: "not_self" });
	expect(s.log).toEqual([]);
});

test("a chat opened during the wait is never taken for the dialog: its own 전송 is not pressed", () => {
	const other = chatWindow("친구");
	const s = world({ paste: w => void w.windows.push(other) });
	expect(s.attach()).toMatchObject({ ok: false, why: "no_dialog" });
	expect(s.log).toEqual(["paste"]);
	expect(s.clipboard()).toBe(owners);
});

test("a chat opened while the dialog is up cancels the dialog instead of pressing it", () => {
	const other = chatWindow("친구");
	const s = world({ paste: w => (sheet(w, () => {}), w.windows.push(other)) });
	expect(s.attach()).toMatchObject({ ok: false, why: "other_window" });
	expect(s.log).toEqual(["paste", "cancel"]);
	expect(s.clipboard()).toBe(owners);
});

test("no dialog in the background fails without raising anything, and a newer copy of the owner's is not overwritten", () => {
	const s = world({ paste: w => void w.pb.writeObjects({ values: [{ saved: ["newer copy"] }] }) });
	expect(s.attach()).toMatchObject({ ok: false, why: "no_dialog" });
	expect(s.log).toEqual(["paste"]);
	expect(s.clipboard()).toBe('[["newer copy"]]');
});

test("an unreadable clipboard type is reported as not restored", () => {
	const s = world({ paste: () => {} });
	s.pb.items = [{ types: { count: 1, objectAtIndex: () => "x" }, dataForType: () => null }];
	expect(s.attach()).toMatchObject({ ok: false, why: "no_dialog", clipboard: false });
});
