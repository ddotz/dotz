import { expect, test } from "bun:test";
import { shortCache } from "./short-cache.ts";

const LONG = () => ({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] });

function runner(kind: "main" | "sub") {
	let handler: (event: unknown, ctx: unknown) => unknown = () => undefined;
	shortCache({ on: (name, fn) => void (name === "before_provider_request" && (handler = fn)) }, kind);
	return (ctx: unknown, payload: unknown = LONG()) => handler({ payload }, ctx);
}

const env = (values: Record<string, string>, run: () => void) => {
	const saved = { runtime: process.env.DOTZ_RUNTIME, depth: process.env.OMO_SENPI_TASK_DEPTH };
	delete process.env.DOTZ_RUNTIME;
	delete process.env.OMO_SENPI_TASK_DEPTH;
	Object.assign(process.env, values);
	try {
		run();
	} finally {
		for (const [key, value] of [["DOTZ_RUNTIME", saved.runtime], ["OMO_SENPI_TASK_DEPTH", saved.depth]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

const ttl = (result: unknown) => (result as { system: { cache_control: { ttl?: string } }[] } | undefined)?.system[0]?.cache_control.ttl;

test("omp: ctx.agent decides which runner drops the 1-hour cache write", () => {
	env({}, () => {
		const main = runner("main");
		const sub = runner("sub");
		expect(main({ agent: { kind: "main" } })).toBeDefined();
		expect(main({ agent: { kind: "sub" } })).toBeUndefined();
		expect(sub({ agent: { kind: "sub" } })).toBeDefined();
		expect(sub({ agent: { kind: "main" } })).toBeUndefined();
	});
});

test("OmO has no ctx.agent: an OmO lane (the main agent of its process) keeps the 1-hour cache write, as laneidle's 20-minute park relies on; an OmO task worker (OMO_SENPI_TASK_DEPTH) drops it", () => {
	env({ DOTZ_RUNTIME: "omo" }, () => {
		const reply = runner("main")({});
		expect(reply).toBeUndefined();
	});
	env({ DOTZ_RUNTIME: "omo", OMO_SENPI_TASK_DEPTH: "1" }, () => {
		const reply = runner("sub")({});
		expect(reply).toBeDefined();
		expect(ttl(reply)).toBeUndefined();
	});
});

test("a request without a long-lived write, or without a payload, is left alone", () => {
	env({}, () => {
		const main = runner("main");
		expect(main({ agent: { kind: "main" } }, { system: [{ type: "text", text: "x" }] })).toBeUndefined();
		expect(main({ agent: { kind: "main" } }, null)).toBeUndefined();
	});
});
