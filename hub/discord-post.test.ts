import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { migratePostSettings, postKind, postSettings, savePostSettings, setWebLane } from "./discord-post.ts";
import type { NoticeClass } from "./notice-class.ts";
import { postClass, route } from "./notify-route.ts";

const discordPosts = (target: string, replyTo?: string, cls?: NoticeClass): boolean => route({ target, ...(replyTo ? { replyTo } : {}), ...(cls ? { cls } : {}) }).messengers.discord;

// Which conversations also go to Discord: the owner's switches in <DATA_DIR>/discord-post.json.
const FILE = join(DATA_DIR, "discord-post.json");
afterEach(() => {
	rmSync(FILE, { force: true });
	setWebLane(() => false);
});

const ON = { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: true, news: true, conv: true };
const OFF = { chat: false, lanes: false, alert: false, worklog: false, web_lanes: false, ask: false, result: false, news: false, conv: false };

test("without the file every kind goes to Discord, as before the switches existed (web-started sessions excepted)", () => {
	expect(postSettings()).toEqual(ON);
	expect(["main", "lane:x", "alert", "worklog", "ch:1", "th:2"].every(t => discordPosts(t))).toBe(true);
});

test("a kind switched off stays on the web; an answer to a message written on Discord still goes there", () => {
	savePostSettings({ chat: false, alert: false });
	expect(discordPosts("main")).toBe(false);
	expect(discordPosts("ch:123")).toBe(false);
	expect(discordPosts("alert")).toBe(false);
	expect(discordPosts("lane:x")).toBe(true);
	expect(discordPosts("worklog")).toBe(true);
	expect(discordPosts("main", "1559940386452152350")).toBe(true);   // a Discord message id: he asked there
	expect(discordPosts("main", "web-1729900000000")).toBe(false);
	expect(postKind("lane:a")).toBe("lanes");
});

test("first start: today's routing where Discord is connected, web only where it is not; an existing file is kept", () => {
	migratePostSettings(true);
	expect(postSettings()).toEqual(ON);
	rmSync(FILE);
	migratePostSettings(false);
	expect(postSettings()).toEqual(OFF);
	savePostSettings({ alert: true });
	migratePostSettings(true);
	expect(postSettings().alert).toBe(true);
	expect(postSettings().chat).toBe(false);
});

test("a session started from the web never posts to Discord, whatever the lanes switch", () => {
	setWebLane(name => name === "webby");
	expect(discordPosts("lane:webby")).toBe(false);
	expect(discordPosts("lane:webby", "1559940386452152350")).toBe(false);
	expect(discordPosts("lane:other")).toBe(true);
});

test("unknown keys and non-booleans are refused and change nothing", () => {
	expect(() => savePostSettings({ mail: false })).toThrow();
	expect(() => savePostSettings({ chat: "no" })).toThrow();
	expect(postSettings().chat).toBe(true);
});

test("an existing file without the class keys keeps today's routing: ask, news, conv follow chat, result follows lanes", () => {
	writeFileSync(FILE, JSON.stringify({ chat: false, lanes: true, alert: true, worklog: true, web_lanes: false }));
	expect(postSettings()).toEqual({ chat: false, lanes: true, alert: true, worklog: true, web_lanes: false, ask: false, result: true, news: false, conv: false });
	writeFileSync(FILE, JSON.stringify({ chat: true, lanes: false, alert: true, worklog: true, web_lanes: false }));
	expect(postSettings()).toMatchObject({ ask: true, result: false, news: true, conv: true });
	writeFileSync(FILE, JSON.stringify({ chat: false, lanes: false, alert: true, worklog: true, web_lanes: false, news: true }));
	expect(postSettings()).toMatchObject({ ask: false, result: false, news: true, conv: false });
});

test("a new install without Discord has every class off; one class can be switched on alone", () => {
	migratePostSettings(false);
	expect(postSettings()).toEqual(OFF);
	savePostSettings({ news: true });
	expect(postSettings()).toEqual({ ...OFF, news: true });
	expect(discordPosts("ch:1", undefined, "news")).toBe(true);
	expect(discordPosts("ch:1", undefined, "conv")).toBe(false);
});

test("postClass: the class of an outgoing post, or none for progress and the work log", () => {
	expect(postClass("main", "[ask] \ubc30\ud3ec\ud560\uae4c\uc694?")).toBe("ask");
	expect(postClass("lane:x", "[ask] \uc9c8\ubb38")).toBe("ask");
	expect(postClass("alert", "gateway stopped")).toBe("alert");
	expect(postClass("lane:x", "[done] \ub05d")).toBe("result");
	expect(postClass("lane:x", "[fail] \uc2e4\ud328")).toBe("result");
	expect(postClass("lane:x", "\ubcf4\uace0", { lane_report: true })).toBe("result");
	expect(postClass("th:9", "\uc0c8 \uba54\uc77c", { source: "gateway", mail: true })).toBe("news");
	expect(postClass("ch:1", "\uac10\uc2dc \uacb0\uacfc", { source: "gateway", news: true })).toBe("news");
	for (const t of ["main", "ch:1", "th:2", "settings:app"]) expect(postClass(t, "\ub2f5\uc774\uc5d0\uc694")).toBe("conv");
	expect(postClass("main", "[done] \ub2f5\uc774\uc5d0\uc694", { source: "orchestrator" })).toBe("conv");
	expect(postClass("lane:x", "[run] \uc9c4\ud589 \uc911")).toBeUndefined();
	expect(postClass("main", "[run] \uc9c4\ud589 \uc911")).toBeUndefined();
	expect(postClass("worklog", "[done] \uc791\uc5c5 \ub05d")).toBeUndefined();
	expect(postClass("alert", "\uc9c4\ud589", { update_key: "alert-1" })).toBeUndefined();
	expect(postClass("main", "\uc7a0\uae50\ub9cc\uc694", { source: "gateway" })).toBeUndefined();
	expect(postClass("main", "\ub300\uae30", { source: "gateway", system: "deferred" })).toBeUndefined();
});

test("a given class decides, whatever the target's kind; without one the target's kind does", () => {
	savePostSettings({ chat: true, lanes: true, ask: false, conv: false, news: true });
	expect(discordPosts("main")).toBe(true);
	expect(discordPosts("main", undefined, "ask")).toBe(false);
	expect(discordPosts("lane:x", undefined, "ask")).toBe(false);
	expect(discordPosts("lane:x")).toBe(true);
	savePostSettings({ chat: false, news: true });
	expect(discordPosts("main", undefined, "news")).toBe(true);
	expect(discordPosts("main")).toBe(false);
});

test("an answer to a Discord message still posts when its class is off; a web lane never posts, whatever the class", () => {
	savePostSettings({ conv: false, result: true });
	expect(discordPosts("main", "1559940386452152350", "conv")).toBe(true);
	expect(discordPosts("main", "web-1729900000000", "conv")).toBe(false);
	setWebLane(name => name === "webby");
	expect(discordPosts("lane:webby", undefined, "result")).toBe(false);
	expect(discordPosts("lane:webby", "1559940386452152350", "result")).toBe(false);
	expect(discordPosts("lane:other", undefined, "result")).toBe(true);
});
