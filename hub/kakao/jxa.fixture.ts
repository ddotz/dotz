// Loads the real room.jxa.js outside osascript for tests: the ObjC bridge, System Events and `delay` are stubbed, and the script's clock
// (Date.now) is a fake that `delay` advances, so its `until` waits end at once and deterministically. Only pure decisions and the send step
// against a fake window are exercised; nothing here touches KakaoTalk.
import src from "./room.jxa.js" with { type: "text" };

export type Jxa = {
	inputVerdict: (value: string, ph: string, text: string, ours: string[], priorPressed: string[]) => "free" | "same_pressed" | "prior_left" | "ours" | "owner";
	rowStillIs: (texts: string[], name: string, expect?: { members?: number; noCount?: boolean; preview?: string }) => boolean;
	sendInto: (name: string, text: string, ours: string[], priorPressed: string[]) => { ok: boolean; why?: string; pressed?: boolean; left?: string; preview?: string };
	setWindowNamed: (fn: (name: string) => unknown) => void;
};

export function loadJxa(): Jxa {
	let t = 0;
	const fakeDate = { now: () => t };
	const delay = (s: number) => {
		t += s * 1000;
	};
	const objc = { import() {}, bindFunction() {}, deepUnwrap: (x: unknown) => x, unwrap: (x: unknown) => x };
	const noApp = () => {
		throw new Error("no System Events in tests");
	};
	const body = `${src}\nreturn { inputVerdict: inputVerdict, rowStillIs: rowStillIs, sendInto: sendInto, setWindowNamed: function (fn) { windowNamed = fn; } };`;
	return new Function("ObjC", "$", "Application", "delay", "Ref", "Date", body)(objc, {}, noApp, delay, () => [], fakeDate) as Jxa;
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
