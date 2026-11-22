import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cfg, DATA_DIR, OMP } from "./config.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { isTextEvent, LIMIT_ERROR, OMO_FLAGS, ompFlags, ompOverlay, runnerDeps } from "./model-runner.ts";
import { callModel, languageMismatch, modelArgv, modelDeps, needsRewrite } from "./outlang.ts";
import { OMO } from "./runtime/omo-hosts.ts";
import { clock, flush } from "./runtime/test-clock.ts";

test("a list of names is not English prose to rewrite; an English sentence is, a Korean one is not", () => {
	expect(languageMismatch("contact_manager, credit_suite, daily_news, dotz, findr, docgen, insane-search, journal, kami, omo, pstack, senpi", "ko")).toBe(false);
	expect(languageMismatch("dotz\nfindr\ndocgen\npstack", "ko")).toBe(false);
	expect(languageMismatch("Now a throwaway smoke script against a temp DOTZ_DIR.", "ko")).toBe(true);
	expect(languageMismatch("저장소 12개를 확인했어요: dotz, findr, docgen.", "ko")).toBe(false);
});

test("a send card in another language is never rewritten: the owner approves the mail's own words, not a translation", () => {
	const saved = { identity: cfg.identity, outlang: Reflect.get(cfg, "output_language") };
	cfg.identity = { ...cfg.identity, language: "ko" };
	Reflect.set(cfg, "output_language", "rewrite");
	try {
		const words = "Thanks for the note. Tuesday works for me, and I will bring the slides from last week. ".repeat(12).trim();
		expect(needsRewrite(words)).toBe(true);
		const card = `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "Sam <sam@example.com>", subject: "Re: plans", body: `Hi Sam,\n\n${words}\n\nBest regards`, ref: "R1AB2CD", question: "이 답장 보낼까요?" })}`;
		expect(languageMismatch(card, "ko")).toBe(true);
		expect(needsRewrite(card)).toBe(false);
	} finally {
		cfg.identity = saved.identity;
		Reflect.set(cfg, "output_language", saved.outlang);
	}
});

const saved = { spawn: modelDeps.spawn, which: runnerDeps.which, runtime: Reflect.get(cfg, "runtime") };
afterEach(() => {
	modelDeps.spawn = saved.spawn;
	runnerDeps.which = saved.which;
	Reflect.set(cfg, "runtime", saved.runtime);
});

const flag = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];
const enc = (s: string) => new TextEncoder().encode(s);
const end = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1 } } });
type Stub = { stdout: string; stderr?: string; code?: number; signalCode?: string };
const stubs = (make: (stdin: string) => Stub): { stdins: string[] } => {
	const stdins: string[] = [];
	modelDeps.spawn = ((_argv: string[], options: { stdin: Uint8Array }) => {
		const stdin = new TextDecoder().decode(options.stdin);
		stdins.push(stdin);
		const r = make(stdin);
		return { stdout: new Response(r.stdout).body, ...(r.stderr === undefined ? {} : { stderr: new Response(r.stderr).body }), exited: Promise.resolve(r.code ?? 0), signalCode: r.signalCode ?? null };
	}) as unknown as typeof modelDeps.spawn;
	return { stdins };
};

test("an omp call takes its text on stdin: the argv ends with the system prompt, the model is the subscription's omp name, and the context files stay off", () => {
	Reflect.set(cfg, "runtime", "omp");
	const argv = modelArgv("sys", "anthropic-subscription/claude-sonnet-5-5:high");
	expect([argv[0], argv[1], flag(argv, "--thinking"), flag(argv, "--model"), argv.at(-2), argv.at(-1)]).toEqual([OMP, "-p", "high", "anthropic/claude-sonnet-5-5", "--system-prompt", "sys"]);
	expect(argv).toEqual(expect.arrayContaining(ompFlags()));
	expect(argv).toContain("--no-context-files");
	expect(flag(modelArgv("sys", undefined), "--model")).toBe("anthropic/claude-sonnet-5-5");
	expect(flag(modelArgv("sys", "@tiny"), "--model")).toBe("@tiny");
});

test("an OmO call keeps its own provider name and ends with the stdin marker", () => {
	Reflect.set(cfg, "runtime", "omo");
	const argv = modelArgv("sys", "anthropic/claude-sonnet-5-5");
	expect([argv[0], flag(argv, "--model"), argv.at(-1)]).toEqual([OMO, "anthropic-subscription/claude-sonnet-5-5", "-"]);
	expect(argv).toEqual(expect.arrayContaining(OMO_FLAGS));
});

test("the claude runtime has no print mode: its one-shot calls take omp when installed, else OmO, else fail", () => {
	Reflect.set(cfg, "runtime", "claude");
	runnerDeps.which = bin => (bin === OMP ? "/bin/omp" : bin === OMO ? "/bin/omo" : null);
	expect(modelArgv("sys", undefined)[0]).toBe(OMP);
	runnerDeps.which = bin => (bin === OMO ? "/bin/omo" : null);
	expect(modelArgv("sys", undefined)[0]).toBe(OMO);
	runnerDeps.which = () => null;
	expect(() => modelArgv("sys", undefined)).toThrow("no one-shot model runtime");
});

test("the overlay is rewritten when an older install lacks the pins, and pins memory, advisor, keywords, usage waiting, fallback and the update check", () => {
	const file = ompOverlay();
	writeFileSync(file, 'memory:\n  backend: "off"\n');
	expect(ompOverlay()).toBe(file);
	const text = readFileSync(file, "utf8");
	for (const pin of ['memory:\n  backend: "off"', "advisor:\n  enabled: false", "magicKeywords:\n  enabled: false", "waitForUsageReset: false", "modelFallback: false", "checkUpdate: false"]) expect(text).toContain(pin);
	expect(file).toBe(`${DATA_DIR}/outlang-overlay.yml`);
	expect(ompFlags()[0]).toBe(`--config=${file}`);
});

test("omp text is shielded against @path inlining and a leading slash command, and the reply is restored; OmO text goes in as written", async () => {
	Reflect.set(cfg, "runtime", "omp");
	const seen = stubs(() => ({ stdout: `${end("보세요 @\u200B/etc/hosts and a@b")}\n` }));
	const text = 'Check @/etc/hosts please.\nsee (@a) `@b` @"c d" x@y';
	const r = await callModel("sys", text);
	expect(seen.stdins[0]).toBe('Check @\u200B/etc/hosts please.\nsee (@\u200Ba) `@\u200Bb` @\u200B"c d" x@y');
	expect(r.text).toBe("보세요 @/etc/hosts and a@b");
	await callModel("sys", "  /session now");
	expect(seen.stdins[1]).toBe("  \u200B/session now");
	Reflect.set(cfg, "runtime", "omo");
	Reflect.set(cfg, "model_warm", false);
	try {
		await callModel("sys", text, { model: "openai/gpt-5" });
	} finally {
		Reflect.deleteProperty(cfg, "model_warm");
	}
	expect(seen.stdins[2]).toBe(text);
});

test("a one-shot call reads the model's own error, a timeout, a crash line and an empty reply apart", async () => {
	Reflect.set(cfg, "runtime", "omp");
	const failing = (stub: Stub, timeoutMs = 3000) => {
		stubs(() => stub);
		return callModel("sys", "hi", { timeoutMs }).then(
			() => "no error",
			(e: Error) => e.message,
		);
	};
	const errored = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error: usage limit reached" } });
	expect(await failing({ stdout: `${errored}\n` })).toBe("429 rate_limit_error: usage limit reached");
	expect(await failing({ stdout: "starting\nTypeError: boom\n", stderr: "warn one\nfatal: no login\n", code: 2 })).toBe("model call exited 2: fatal: no login");
	expect(await failing({ stdout: "TypeError: boom\n", code: 1 })).toBe("model call exited 1: TypeError: boom");
	expect(await failing({ stdout: "", code: 143, signalCode: "SIGTERM" })).toBe("model call timed out after 3s");
	expect(await failing({ stdout: "", code: 143 })).toBe("model call exited 143");
	expect(await failing({ stdout: `${end("   ")}\n` })).toBe("empty reply");
	expect(await failing({ stdout: "" })).toBe("empty reply");
});

test("a real process killed by the call's timeout reports the timeout, not an empty reply", async () => {
	Reflect.set(cfg, "runtime", "omp");
	modelDeps.spawn = ((_argv, options) => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], options as never)) as typeof modelDeps.spawn;
	await expect(callModel("sys", "hi", { timeoutMs: 300 })).rejects.toThrow("model call timed out after 0s");
});

test("the first token time is the first text event, not the first byte of output", async () => {
	Reflect.set(cfg, "runtime", "omp");
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const stdout = new ReadableStream<Uint8Array>({
		async start(c) {
			c.enqueue(enc(`${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n`));
			await gate;
			c.enqueue(enc(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })}\n${end("ok")}\n`));
			c.close();
		},
	});
	modelDeps.spawn = (() => ({ stdout, exited: gate.then(() => 0) })) as unknown as typeof modelDeps.spawn;
	const call = callModel("sys", "u", { timeoutMs: 5000 });
	await flush();
	clock.now += 40;
	release();
	expect((await call).firstTokenMs).toBe(40);
	expect([isTextEvent({ assistantMessageEvent: { type: "thinking_start" } }), isTextEvent({ assistantMessageEvent: { type: "toolcall_delta" } }), isTextEvent({})]).toEqual([true, false, false]);
});

test("one limit pattern covers the provider's limit wordings and nothing else", () => {
	for (const why of ["429 rate_limit_error: usage limit reached", "Rate limit exceeded", "You exceeded your current quota", "Usage-limit hit", "Your account has been temporarily blocked", "provider not_ready", "구독 한도에 걸렸어요"]) expect(LIMIT_ERROR.test(why)).toBe(true);
	for (const why of ["empty reply", "model call exited 1: unauthorized", "request blocked by the firewall", "model call timed out after 45s", "tokens: 4290 in"]) expect(LIMIT_ERROR.test(why)).toBe(false);
});
