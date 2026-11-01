import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { discordPosts, migratePostSettings, postKind, postSettings, savePostSettings, setWebLane } from "./discord-post.ts";

// Which conversations also go to Discord: the owner's switches in <DATA_DIR>/discord-post.json.
const FILE = join(DATA_DIR, "discord-post.json");
afterEach(() => {
	rmSync(FILE, { force: true });
	setWebLane(() => false);
});

test("without the file every kind goes to Discord, as before the switches existed (web-started sessions excepted)", () => {
	expect(postSettings()).toEqual({ chat: true, lanes: true, alert: true, worklog: true, web_lanes: false });
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
	expect(postSettings()).toEqual({ chat: true, lanes: true, alert: true, worklog: true, web_lanes: false });
	rmSync(FILE);
	migratePostSettings(false);
	expect(postSettings()).toEqual({ chat: false, lanes: false, alert: false, worklog: false, web_lanes: false });
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
