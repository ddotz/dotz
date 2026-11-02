import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "./messenger.ts";
import { createJandiAdapter, jandiConfigPath, loadJandiConfig, type JandiAdapter } from "./messenger-jandi.ts";
import { messengersRoute } from "./messengers-api.ts";

let dir: string;
let adapter: JandiAdapter;
let incoming: ReturnType<typeof Bun.serve>;
let posts: { path: string; body: any }[];
let failPath = "";

const call = async (method: string, path: string, body?: unknown) => {
	const url = new URL(`http://hub${path}`);
	const res = await messengersRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, url.pathname.split("/").filter(Boolean));
	return { status: res!.status, json: (await res!.json()) as any };
};
const room = (j: any, id: string) => j.rooms.items.find((r: any) => r.id === id);

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "messengers-api-"));
	posts = [];
	incoming = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			posts.push({ path, body: await req.json() });
			return path === failPath ? new Response("no", { status: 500 }) : new Response("{}");
		},
	});
	adapter = createJandiAdapter(dir);
	register(adapter);
});

afterAll(() => {
	incoming.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("messenger settings api", () => {
	test("lists the adapters, hidden ones left out", async () => {
		const { status, json } = await call("GET", "/api/messengers");
		expect(status).toBe(200);
		expect(json.items.find((i: any) => i.id === "jandi")).toEqual({ id: "jandi", label: "JANDI", enabled: false, state: "off" });
		adapter.hidden = () => true;
		expect((await call("GET", "/api/messengers")).json.items.some((i: any) => i.id === "jandi")).toBe(false);
		expect((await call("GET", "/api/messengers/jandi")).status).toBe(404);
		delete adapter.hidden;
	});

	test("unknown id is 404, a bad body is 400 and changes nothing", async () => {
		expect((await call("GET", "/api/messengers/nope")).status).toBe(404);
		expect((await call("POST", "/api/messengers/nope/test")).status).toBe(404);
		for (const bad of [{ enabled: "yes" }, { values: { port: 70000 } }, { rooms: [{ name: "x", kind: "nope" }] }, { rooms: [{ name: "x", kind: "project" }] }, { rooms: [{ kind: "main", values: { incoming_url: "ftp://x" } }] }, { allow: [1] }]) {
			expect((await call("PUT", "/api/messengers/jandi", bad)).status).toBe(400);
		}
		expect(loadJandiConfig(dir).rooms).toEqual([]);
	});

	test("PUT creates rooms; GET never returns a secret, only set", async () => {
		const put = await call("PUT", "/api/messengers/jandi", {
			enabled: false,
			values: { host: "127.0.0.1", port: 0 },
			allow: ["Boss@Corp.test", "홍길동"],
			rooms: [
				{ id: "m1", name: "메인", kind: "main", values: { outgoing_token: "tok-secret-1", incoming_url: `http://127.0.0.1:${incoming.port}/in/m1` } },
				{ id: "p1", name: "프로젝트", kind: "project", project: "ch:123", values: { outgoing_token: "tok-secret-2", incoming_url: `http://127.0.0.1:${incoming.port}/in/p1` } },
				{ name: "알림", kind: "alert" },
			],
		});
		expect(put.status).toBe(200);
		const got = (await call("GET", "/api/messengers/jandi")).json;
		const text = JSON.stringify(got);
		expect(text).not.toContain("tok-secret");
		expect(text).not.toContain("/in/m1");
		expect(got.allow.items).toEqual(["boss@corp.test", "홍길동"]);
		expect(room(got, "m1").set).toEqual({ outgoing_token: true, incoming_url: true });
		expect(room(got, "p1").project).toEqual({ target: "ch:123", name: "ch:123" });
		const fresh = got.rooms.items.find((r: any) => r.kind === "alert");
		expect(fresh.id).toMatch(/^r[0-9a-f]{8}$/);
		expect(fresh.set).toEqual({ outgoing_token: false, incoming_url: false });
		expect(room(got, "m1").values.webhook).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/jandi\/m1$/);
		expect(got.rooms.fields.map((f: any) => [f.key, f.type])).toEqual([["webhook", "copy"], ["outgoing_token", "secret"], ["incoming_url", "secret"]]);
	});

	test("PUT omit keeps a secret, \"\" clears it, and the file stays 0600", async () => {
		await call("PUT", "/api/messengers/jandi", { rooms: [{ id: "m1", name: "메인 바뀜", kind: "main" }, { id: "p1", kind: "project", values: { outgoing_token: "" } }] });
		const cfg = loadJandiConfig(dir);
		expect(cfg.rooms.map(r => r.id)).toEqual(["m1", "p1"]);
		expect(cfg.rooms[0]).toMatchObject({ name: "메인 바뀜", outgoing_token: "tok-secret-1" });
		expect(cfg.rooms[0]!.incoming_url).toContain("/in/m1");
		expect(cfg.rooms[1]).toMatchObject({ project: "ch:123", outgoing_token: "" });
		expect(cfg.rooms[1]!.incoming_url).toContain("/in/p1");
		expect(statSync(jandiConfigPath(dir)).mode & 0o777).toBe(0o600);
		expect(readFileSync(jandiConfigPath(dir), "utf8")).toContain("tok-secret-1");
	});

	test("the test endpoint posts a short body to each incoming URL and reports per room", async () => {
		failPath = "/in/p1";
		posts.length = 0;
		const { status, json } = await call("POST", "/api/messengers/jandi/test");
		expect(status).toBe(200);
		expect(json.results).toEqual([
			{ id: "m1", name: "메인 바뀜", ok: true, status: 200 },
			{ id: "p1", name: "프로젝트", ok: false, status: 500, error: "HTTP 500" },
		]);
		expect(posts.map(p => p.path).sort()).toEqual(["/in/m1", "/in/p1"]);
		expect(posts[0]!.body.body).toContain("dotz");
		expect(JSON.stringify(json)).not.toContain("/in/");
	});

	test("changing enabled or the listen address restarts the listener", async () => {
		const stopped: string[] = [];
		const stop = adapter.stop.bind(adapter);
		adapter.stop = () => {
			stopped.push("stop");
			return stop();
		};
		await call("PUT", "/api/messengers/jandi", { allow: ["a@b.test"] });
		expect(stopped).toEqual([]);
		await call("PUT", "/api/messengers/jandi", { enabled: true });
		expect(stopped).toEqual(["stop"]);
		await call("PUT", "/api/messengers/jandi", { values: { port: 0, host: "127.0.0.1" } });
		expect(stopped).toEqual(["stop"]);
		await call("PUT", "/api/messengers/jandi", { values: { host: "localhost" } });
		expect(stopped).toEqual(["stop", "stop"]);
		adapter.stop = stop;
	});

	test("Discord is read-only: GET works, PUT is 400, with a link to its screen", async () => {
		const { discordAdapter } = await import("./messenger-discord.ts");
		register(discordAdapter);
		const got = await call("GET", "/api/messengers/discord");
		expect(got.status).toBe(200);
		expect(got.json.link).toEqual({ label: "Discord 설정 열기", view: "discord" });
		expect(got.json.fields.every((f: any) => f.type === "readonly")).toBe(true);
		expect((await call("PUT", "/api/messengers/discord", { enabled: true })).status).toBe(400);
	});
});
