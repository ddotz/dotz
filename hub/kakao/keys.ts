// Types text into ONE process (CGEventPostToPid) as unicode key events, one character at a time, like a person typing. KakaoTalk
// enables its login button only on real key input; posting to its pid needs no activation and never reaches another app.
// The text is never logged. The process must hold the Accessibility permission (the gateway's bun does after setup).
import { dlopen, FFIType, ptr } from "bun:ffi";

let lib: ReturnType<typeof open> | undefined;
function open() {
	return dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", {
		CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
		CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
		CGEventPostToPid: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.void },
		CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
	});
}

export async function typeToPid(pid: number, text: string, sleep: (ms: number) => Promise<void>, gapMs = 35): Promise<void> {
	lib ??= open();
	const s = lib.symbols;
	for (const ch of text) {
		const units = new Uint16Array(ch.length);
		for (let i = 0; i < ch.length; i++) units[i] = ch.charCodeAt(i);
		for (const down of [true, false]) {
			const ev = s.CGEventCreateKeyboardEvent(null, 0, down);
			if (!ev) throw new Error("key event");
			s.CGEventKeyboardSetUnicodeString(ev, units.length, ptr(units));
			s.CGEventPostToPid(pid, ev);
			s.CFRelease(ev);
		}
		units.fill(0);
		await sleep(gapMs);
	}
}
