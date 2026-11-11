import { describe, expect, test } from "bun:test";
import { jsonZod, params } from "./schema.ts";
import { findBun, recallArgv, recallTool, type RunCli } from "./recall-tool.ts";

function register(run: RunCli) {
	const tools: any[] = [];
	recallTool({ zod: jsonZod, registerTool: (t: unknown) => tools.push(t) }, "/data", run);
	return tools[0];
}

describe("dotz_recall", () => {
	test("is a deferred tool without a prompt snippet", () => {
		const t = register(async () => "");
		expect(t.name).toBe("dotz_recall");
		expect(t.exposure).toBe("search");
		expect(t.promptSnippet).toBeUndefined();
	});

	test("a search maps every parameter to flags and puts the query after --", () => {
		expect(recallArgv({ query: " fix it ", also: ["a b", " "], after: "2026-01-01", before: "2026-02-01", project: "app", limit: 5.7 })).toEqual([
			"search", "--also", "a b", "--after", "2026-01-01", "--before", "2026-02-01", "--project", "app", "--limit", "5", "--", "fix it",
		]);
		expect(recallArgv({ query: "--zebra" }).slice(-2)).toEqual(["--", "--zebra"]);
	});

	test("open wins over a query and runs the CLI open command with the data dir", async () => {
		const seen: [string[], string][] = [];
		const t = register(async (argv, dir) => (seen.push([argv, dir]), "raw text"));
		const r = await t.execute("1", { query: "ignored", open: "abc123" });
		expect(seen).toEqual([[["open", "abc123"], "/data"]]);
		expect(r.content[0].text).toBe("raw text");
	});

	test("a call with neither query nor open does not start the CLI", async () => {
		let called = false;
		const t = register(async () => ((called = true), ""));
		const r = await t.execute("1", { query: "  " });
		expect(called).toBe(false);
		expect(r.content[0].text).toContain("recall failed");
	});

	test("the schema lists the documented parameters, none required, limit bounded", () => {
		const schema = params(register(async () => "").parameters);
		expect(Object.keys(schema.properties).sort()).toEqual(["after", "also", "before", "limit", "open", "project", "query"]);
		expect(schema.required).toBeUndefined();
		expect(schema.properties.limit).toEqual({ type: "number", minimum: 1, maximum: 20 });
	});
});

describe("findBun", () => {
	const has = (...paths: string[]) => (p: string) => paths.includes(p);
	test("a host named bun is used as is", () => {
		expect(findBun("/x/bun", {}, has())).toBe("/x/bun");
	});
	test("another host binary: first bun on PATH, then the usual places, else the bare name", () => {
		expect(findBun("/x/omo", { PATH: "/a:/b" }, has("/b/bun"))).toBe("/b/bun");
		expect(findBun("/x/omo", { PATH: "/a", HOME: "/h" }, has("/h/.bun/bin/bun"))).toBe("/h/.bun/bin/bun");
		expect(findBun("/x/omo", { PATH: "/a", HOME: "/h" }, has())).toBe("bun");
	});
});
