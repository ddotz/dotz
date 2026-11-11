// Loads the real room.jxa.js outside osascript for tests: the ObjC bridge, System Events and `delay` are stubbed, and the script's clock
// (Date.now) is a fake that `delay` advances, so its `until` waits end at once and deterministically. Only pure decisions and the send step
// against a fake window are exercised; nothing here touches KakaoTalk.
import attachSrc from "./attach.jxa.js" with { type: "text" };
import src from "./room.jxa.js" with { type: "text" };

export type Jxa = {
	inputVerdict: (value: string, ph: string, text: string, ours: string[], priorPressed: string[]) => "free" | "same_pressed" | "prior_left" | "ours" | "owner";
	rowStillIs: (texts: string[], name: string, expect?: { members?: number; noCount?: boolean; preview?: string }) => boolean;
	sendInto: (name: string, text: string, ours: string[], priorPressed: string[]) => { ok: boolean; why?: string; pressed?: boolean; left?: string; preview?: string };
	attachFile: (name: string, path: string) => { ok: boolean; why?: string; pressed?: boolean; clipboard?: boolean };
	setWindowNamed: (fn: (name: string) => unknown) => void;
	norm: (s: string) => string;
	axListNative: () => { table: unknown; rows: unknown[] } | null;
	axVisibleRows: (table: unknown) => number[];
	axReveal: (list: unknown, index: number) => { moved: boolean; first?: number };
	axRestore: (list: unknown, rev: { moved: boolean; first?: number }) => void;
	axScan: (name: string, first: boolean, budgetMs: number, hint?: number, need?: number, memo?: number) => { ok: true; rows: number; scanned: number; hits: { index: number; texts: string[] }[]; stopped: "found" | "budget" | "end"; pages: number } | null;
};

// The KakaoTalk chat list as the AX API in room.jxa.js reads it (axList/axRowTitle/axRowTexts): window "카카오톡" > scroll area > table >
// rows > one cell > [profile button (no value), title, member count (groups), time, preview]. Every AX read advances the script's clock by
// `msPerRead`, so a scan budget is spent the way a slow real list spends it.
export type AxRow = { title: string; count?: number; preview?: string };
// `visible`: the window shows only this many rows (AXVisibleRows); a row cell scrolls itself into view when AXScrollToVisible is set to a number.
export function axList(rows: AxRow[], opts: { visible?: number } = {}) {
	const text = (v: string) => ({ AXRole: "AXStaticText", AXValue: v });
	let top = 0;
	const axRows = rows.map((r, i) => ({ AXIndex: i, AXChildren: [{ onScroll: () => (top = Math.min(i, Math.max(0, rows.length - (opts.visible ?? rows.length)))), AXChildren: [{ AXRole: "AXButton", AXValue: "" }, text(r.title), ...(r.count === undefined ? [] : [text(String(r.count))]), text("오후 3:03"), ...(r.preview === undefined ? [] : [text(r.preview)])] }] }));
	const table = {
		AXRole: "AXTable",
		AXRows: axRows,
		get AXVisibleRows() {
			return axRows.slice(top, top + (opts.visible ?? rows.length));
		},
	};
	const listWin = { AXTitle: "카카오톡", AXChildren: [{ AXRole: "AXScrollArea", AXChildren: [table] }] };
	return { AXWindows: [listWin] };
}

export function loadJxa(opts: { app?: ReturnType<typeof axList>; msPerRead?: number; systemEvents?: unknown; objc?: Record<string, unknown> } = {}): Jxa {
	let t = 0;
	const fakeDate = { now: () => t };
	const delay = (s: number) => {
		t += s * 1000;
	};
	const objc = { import() {}, bindFunction() {}, deepUnwrap: (x: unknown) => x, unwrap: (x: unknown) => x };
	const nsNumber = { numberWithInt: (n: number) => n };
	const noApp = () => {
		throw new Error("no System Events in tests");
	};
	// The ObjC bridge of the AX API: one attribute read per call, -25205 (no value) for an attribute the element does not have.
	const $ = opts.app
		? {
				NSNumber: nsNumber,
				NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ js: [{ processIdentifier: 1 }] }) },
				AXUIElementCreateApplication: () => opts.app,
				AXUIElementCopyAttributeValue: (el: Record<string, unknown>, name: string, ref: unknown[]) => {
					t += opts.msPerRead ?? 0;
					if (!el || !(name in el)) return -25205;
					ref[0] = el[name];
					return 0;
				},
				// AXScrollToVisible is taken as a number only (a boolean fails like the real app).
				AXUIElementSetAttributeValue: (el: { onScroll?: () => void }, name: string, value: unknown) => {
					if (name !== "AXScrollToVisible" || !el.onScroll || typeof value !== "number") return -25200;
					el.onScroll();
					return 0;
				},
				// Only an element with an `onPress` hook (a tab button) reacts to AXPress.
				AXUIElementPerformAction: (el: { onPress?: () => void }, action: string) => {
					if (action !== "AXPress" || !el.onPress) return -25205;
					el.onPress();
					return 0;
				},
			}
		: (opts.objc ?? {});
	const body = `${src}\n${attachSrc}\nreturn { inputVerdict: inputVerdict, rowStillIs: rowStillIs, sendInto: sendInto, attachFile: attachFile, norm: norm, axListNative: axList, axVisibleRows: axVisibleRows, axReveal: axReveal, axRestore: axRestore, axScan: axScan, setWindowNamed: function (fn) { windowNamed = fn; } };`;
	const application = opts.systemEvents ? () => opts.systemEvents : noApp;
	return new Function("ObjC", "$", "Application", "delay", "Ref", "Date", body)(objc, $, application, delay, () => [], fakeDate) as Jxa;
}

// A chat window with one input and a 전송 button, as sendInto reads it through System Events: `value` is read as a function and set as a
// property (JXA's form), `press` decides what a press does (clear the input, throw like an AppleEvent timeout, ...).
export function fakeWindow(opts: { value?: string; placeholder?: string; press?: (input: { set: (v: string) => void }) => void } = {}) {
	let value = opts.value ?? "";
	const typed: string[] = [];
	let presses = 0;
	const input: Record<string, unknown> = { placeholderValue: () => opts.placeholder ?? "" };
	Object.defineProperty(input, "value", {
		get: () => () => value,
		set: (v: string) => {
			value = v;
			if (v) typed.push(v);
		},
	});
	const btn = {
		role: () => "AXButton",
		enabled: () => "true",
		actions: {
			byName: () => ({
				perform: () => {
					presses++;
					if (opts.press) opts.press({ set: v => (value = v) });
					else value = "";
				},
			}),
		},
	};
	const win = { scrollAreas: () => [{ textAreas: () => [input] }], buttons: { whose: () => [btn] } };
	return { win, typed, presses: () => presses, value: () => value };
}
