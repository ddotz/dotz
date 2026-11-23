import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { HUB_TOKEN, orchestratorModel } from "./config.ts";
import { changeTarget, resolveModel, targetView } from "./control.ts";
import * as discord from "./discord.ts";
import { convs } from "./convsessions.ts";
import { createDeps, createProject, loadProjects, MAX_TITLE, ProjectCreateError, removeProject, type CreateDeps } from "./projects.ts";
import type { MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";
import { clearChannel, getSetup } from "./workchannels.ts";

const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill() {} })) as unknown as typeof Bun.spawn);
afterAll(() => spawn.mockRestore());

const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "", mailDeps: () => ({}) as MailDeps });
const call = (method: string, path: string, body?: unknown) =>
	route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const post = (body: unknown) => call("POST", "/api/projects", body);
const KOREAN = /[가-힣]/;

const reset = async () => {
	for (const key of Object.keys(loadProjects())) {
		removeProject(key);
		clearChannel(key);
		await convs.remove(key);
	}
	discord.status.enabled = false;
	delete discord.channels.local;
	delete discord.channels.localNext;
	Object.assign(discord.channels, { workCategory: "wcat", work: {}, threads: {} });
};
beforeEach(reset);
afterEach(reset);

const nothingMade = () => {
	expect(discord.channels.work).toEqual({});
	expect(loadProjects()).toEqual({});
};

test("with Discord off a project is a web-only ch:N with its record and setup, listed in state and in the custom list", async () => {
	const r = await post({ title: "메일 자동답장", purpose: "새 메일에 답해요" });
	expect(r.status).toBe(200);
	const made = (await r.json()) as { key: string; title: string };
	expect(made).toEqual({ key: "ch:1", title: "메일 자동답장" });
	expect(discord.isLocalChannel("1")).toBe(true);
	expect(loadProjects()["ch:1"]).toMatchObject({ title: "메일 자동답장", purpose: "새 메일에 답해요" });
	expect(getSetup("1")).toMatchObject({ channel: "1", name: "메일 자동답장", purpose: "새 메일에 답해요" });
	const state = (await (await call("GET", "/api/state")).json()) as { channels: { work: Record<string, string> } };
	expect(state.channels.work["1"]).toBe("메일 자동답장");
	const custom = (await (await call("GET", "/api/custom")).json()) as { projects: Array<{ key: string; name: string; title?: string }> };
	expect(custom.projects.find(p => p.key === "ch:1")).toBeDefined();
});

test("a project with no purpose gets a record and a channel but no setup", async () => {
	const r = await post({ title: "디스코드 설정" });
	expect(r.status).toBe(200);
	expect(loadProjects()["ch:1"]).toMatchObject({ title: "디스코드 설정" });
	expect(loadProjects()["ch:1"]?.purpose).toBeUndefined();
	expect(getSetup("1")).toBeUndefined();
});

test("a bad title, purpose or field type answers 400 with a Korean reason and creates nothing", async () => {
	const bad: unknown[] = [
		{},
		{ title: "" },
		{ title: "   " },
		{ title: "dotz-web" },
		{ title: "x".repeat(MAX_TITLE + 1) },
		{ title: 7 },
		{ title: "메일 자동답장", purpose: "목".repeat(501) },
		{ title: "메일 자동답장", purpose: 5 },
		{ title: "메일 자동답장", model: 3 },
	];
	for (const body of bad) {
		const r = await post(body);
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toMatch(KOREAN);
	}
	nothingMade();
});

test("Discord on without a work category answers 409 and creates nothing", async () => {
	discord.status.enabled = true;
	delete discord.channels.workCategory;
	const r = await post({ title: "메일 자동답장", purpose: "목적" });
	expect(r.status).toBe(409);
	expect(((await r.json()) as { error: string }).error).toContain("디스코드 작업 카테고리");
	nothingMade();
});

test("a model picked while creating is the project's own model, set the way PUT /api/target sets it, and main keeps its own", async () => {
	const main = { ...orchestratorModel() };
	const result = await createProject({ title: "모델 시험", model: "anthropic/claude-sonnet-5-5:low" }, createDeps(async (key, model) => changeTarget(key, { model }), resolveModel));
	expect(result).toEqual({ key: "ch:1", title: "모델 시험" });
	expect(await targetView("ch:1")).toMatchObject({ model: "anthropic/claude-sonnet-5-5", thinking: "low", own: true });
	expect(orchestratorModel()).toEqual(main);
});

test("an agent's call cannot pick a model without the owner's words, and the refused project leaves nothing behind", async () => {
	const r = await post({ title: "모델 시험", purpose: "목적", model: "anthropic/claude-sonnet-5-5" });
	expect(r.status).toBe(403);
	nothingMade();
	expect(getSetup("1")).toBeUndefined();
});

const deps = (over: Partial<CreateDeps> = {}) => {
	const made: string[] = [];
	const removed: string[] = [];
	const d: CreateDeps = {
		createChannel: async name => {
			made.push(name);
			return { id: "4242", name };
		},
		removeChannel: async id => void removed.push(id),
		models: async () => [
			{ selector: "anthropic/claude-sonnet-5-5", name: "Sonnet 5.5", provider: "anthropic", reasoning: true },
			{ selector: "anthropic/claude-haiku-5-5", name: "Haiku 5.5", provider: "anthropic", reasoning: true },
		],
		resolveModel,
		applyModel: async () => undefined,
		...over,
	};
	return { d, made, removed };
};

test("the owner may name a project with a codename-shaped word; an agent's call still needs plain words", async () => {
	const { d, made } = deps();
	expect(await createProject({ title: "notes-app" }, d, false)).toEqual({ key: "ch:4242", title: "notes-app" });
	expect(made).toEqual(["notes-app"]);
	const err = await createProject({ title: "notes-app" }, d).catch((e: unknown) => e);
	expect((err as ProjectCreateError).status).toBe(400);
	expect(made).toEqual(["notes-app"]);
	removeProject("ch:4242");
});

test("an unknown or ambiguous model answers 400 before any channel is made", async () => {
	for (const model of ["gpt-nonexistent", "anthropic", "anthropic/claude-sonnet-5-5:ultra"]) {
		const { d, made } = deps();
		const err = await createProject({ title: "모델 시험", model }, d).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProjectCreateError);
		expect((err as ProjectCreateError).status).toBe(400);
		expect(made).toEqual([]);
	}
	nothingMade();
});

test("a failure after the channel exists removes the channel, its setup and its record", async () => {
	const removed: string[] = [];
	const { d } = deps({
		createChannel: discord.createWorkChannel,
		removeChannel: async id => {
			removed.push(id);
			await discord.deleteWorkChannel(id);
		},
		applyModel: async () => {
			throw new Error("model refused");
		},
	});
	await expect(createProject({ title: "메일 자동답장", purpose: "목적", model: "anthropic/claude-sonnet-5-5" }, d)).rejects.toThrow("model refused");
	expect(removed).toEqual(["1"]);
	expect(getSetup("1")).toBeUndefined();
	nothingMade();
});
