import { styleText } from "node:util";
import * as p from "@clack/prompts";

const CANCEL_TEXT = "취소했어요. 아무것도 저장하지 않았어요.";
let cancelText = CANCEL_TEXT;

/** After the first write the wizard no longer promises that nothing was saved: the cancel line says what to run to go on. */
export function setCancelText(text: string): void {
	cancelText = text;
}

/** Ctrl+C or Esc in any prompt or spinner. */
export function bail(): never {
	p.cancel(wrap(cancelText));
	process.exit(1);
}

const must = <T>(v: T | typeof p.CANCEL_SYMBOL): T => (p.isCancel(v) ? bail() : v);

const columns = (s: string): number => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0);

/** `text` cut to at most `max` terminal columns (a Hangul syllable takes two), ending in an ellipsis when cut. */
export function fit(text: string, max: number): string {
	if (columns(text) <= max) return text;
	let out = "";
	for (const c of text) {
		if (columns(`${out}${c}`) > max - 1) break;
		out += c;
	}
	return `${out.trimEnd()}…`;
}

const screenWidth = (): number => Math.max(40, Math.min(process.stdout.columns ?? 80, 80));

function wrap(text: string, width = screenWidth() - 6): string {
	return text
		.split("\n")
		.flatMap(para => {
			const lines: string[] = [];
			let line = "";
			for (const word of para.split(" ")) {
				const next = line ? `${line} ${word}` : word;
				if (line && columns(next) > width) {
					lines.push(line);
					line = word;
				} else line = next;
			}
			lines.push(line);
			return lines;
		})
		.join("\n");
}

const dim = (s: string): string => styleText("dim", s);
const bold = (s: string): string => styleText("bold", s);

type Out = { ok(text: string): void; warn(text: string): void; fail(text: string): void; info(text: string): void; dim(text: string): void; tight(text: string): void };

/** Status lines with a glyph in the wizard (success, warning, error, info) and bare lines in a plain run. */
export function makeOut(plain: boolean): Out {
	if (plain) return { ok: t => console.log(t), warn: t => console.log(t), fail: t => console.error(t), info: t => console.log(t), dim: t => console.log(t), tight: t => console.log(t) };
	return { ok: t => p.log.success(wrap(t)), warn: t => p.log.warn(wrap(t)), fail: t => p.log.error(wrap(t)), info: t => p.log.info(wrap(t)), dim: t => p.log.message(dim(wrap(t))), tight: t => p.log.message(dim(wrap(t)), { spacing: 0 }) };
}

export const intro = (title: string): void => p.intro(bold(title));
export const outro = (text: string): void => p.outro(wrap(text));
export const note = (text: string, title: string): void => p.note(wrap(text, screenWidth() - 10), title);

/** `n/total title` and one dim line saying why the step exists. */
export function stepHeader(n: number, total: number, title: string, why: string): void {
	p.log.step(`${bold(`${n}/${total} ${title}`)}\n${dim(wrap(why))}`);
}

const KEYS_PICK = "↑↓ 이동 · Enter 확인";

export type Choice<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };

/** Folds each hint into its label (dim), so every option shows its hint and not only the highlighted one. */
export const hinted = <T extends string>(options: Choice<T>[]): Choice<T>[] => options.map(o => ({ value: o.value, label: o.hint ? `${o.label}  ${dim(o.hint)}` : o.label, disabled: o.disabled }));

/** One choice from a list; Ctrl+C ends the wizard. */
export async function pick<T extends string>(o: { message: string; options: Choice<T>[]; initial?: T }): Promise<T> {
	return must(await p.select<T>({ message: `${o.message}  ${dim(KEYS_PICK)}`, options: o.options as p.Option<T>[], initialValue: o.initial, showInstructions: false, maxItems: 9 }));
}

/** One or more choices, picked one at a time: the first pick is required, then "다 골랐어요" ends the list. */
export async function pickMany<T extends string>(o: { message: string; options: Choice<T>[] }): Promise<T[]> {
	const chosen: T[] = [];
	for (;;) {
		const left = o.options.filter(c => !chosen.includes(c.value));
		if (!left.length) return chosen;
		const names = o.options.filter(c => chosen.includes(c.value)).map(c => c.label).join(", ");
		const options: Choice<T | "">[] = chosen.length ? [{ value: "", label: "다 골랐어요" }, ...hinted(left)] : hinted(left);
		const next = await pick<T | "">({ message: chosen.length ? `더 고를까요? (고른 곳: ${names})` : o.message, options });
		if (!next) return chosen;
		chosen.push(next);
	}
}

/** A yes/no question; `labels` renames the two answers (for "done" / "later" style pauses). */
export async function yesNo(message: string, def = true, labels: [string, string] = ["예", "아니요"]): Promise<boolean> {
	return must(await p.confirm({ message, initialValue: def, active: labels[0], inactive: labels[1] }));
}


/** A line of text; Enter takes the default. `check` runs on the final value and its string is shown under the field. */
export async function ask(o: { message: string; def?: string; required?: boolean; check?: (v: string) => string | undefined }): Promise<string> {
	const def = o.def ?? "";
	const r = must(
		await p.text({
			message: o.message,
			placeholder: def,
			defaultValue: def,
			validate: v => {
				const val = (v ?? "").trim() || def;
				if (!val) return o.required === false ? undefined : "꼭 필요한 값이에요";
				return o.check?.(val);
			},
		}),
	);
	return r.trim() || def;
}

/** A hidden value (token, key); nothing is echoed. */
export async function askSecret(message: string, check?: (v: string) => string | undefined): Promise<string> {
	const r = must(await p.password({ message, validate: v => (!v?.trim() ? undefined : check?.(v.trim())) }));
	return r.trim();
}

export type Working = { update(text: string): void; done(text: string): void; fail(text: string): void; clear(): void };

/** A spinner for work that prints nothing itself. Stop it before running anything that inherits the terminal. */
export function working(message: string): Working {
	const s = p.spinner();
	const interrupt = (): never => {
		s.clear();
		return bail();
	};
	const onKey = (_: string, key: { name?: string; ctrl?: boolean } | undefined) => {
		if (key?.ctrl && key.name === "c") interrupt();
	};
	process.prependListener("SIGINT", interrupt);
	s.start(message);
	process.stdin.prependListener("keypress", onKey);
	const end = (finish: () => void) => {
		process.removeListener("SIGINT", interrupt);
		process.stdin.removeListener("keypress", onKey);
		finish();
	};
	return { update: t => s.message(t), done: t => end(() => s.stop(t)), fail: t => end(() => s.error(t)), clear: () => end(() => s.clear()) };
}

/** Runs `fn` under a spinner; `done` turns the result into the line that replaces the spinner, without it the spinner leaves no line. */
export async function whileWorking<T>(message: string, fn: () => Promise<T>, done?: (result: T) => string): Promise<T> {
	const w = working(message);
	try {
		const result = await fn();
		if (done) w.done(done(result));
		else w.clear();
		return result;
	} catch (e) {
		w.clear();
		throw e;
	}
}
