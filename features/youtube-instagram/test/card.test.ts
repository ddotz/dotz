// bin/card.ts: kv JSON of the home card from a temp DOTZ_DIR, the real youtube/instagram/jobs libs and a fake fetch.
// Offline, not connected and before setup must all still print valid JSON and exit 0.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { run } from "../bin/card.ts";
import { type Config, dataDir, defaultConfig, paths, secretsDir, writeJson } from "../lib/config.ts";
import { fakeCtx, SECRETS, YT_ID } from "./fakes.ts";

const HOUR = 3_600_000;
const BEFORE_SETUP = "설정 전이에요. 채팅에서 '유튜브·인스타 설정해줘'라고 말해 주세요";

beforeEach(() => {
	rmSync(join(dataDir(), "custom"), { recursive: true, force: true });
	rmSync(secretsDir(), { recursive: true, force: true });
});

const connect = (which: "youtube" | "instagram" | "both") => {
	const config: Config = defaultConfig();
	if (which !== "instagram") {
		config.youtube = { channel_id: YT_ID, title: "My Channel", base_language: "ko", languages: ["en"], privacy: "private", upload_via: "api" };
		writeJson(paths.ytOauth(), { client_id: "cid", client_secret: SECRETS.clientSecret, refresh_token: SECRETS.refresh }, true);
	}
	if (which !== "youtube") {
		config.instagram = { user_id: "1784", username: "owner", post_via: "api" };
		writeJson(paths.instagram(), { access_token: SECRETS.instagram, user_id: "1784", username: "owner", obtained_at: "2026-10-20T00:00:00.000Z" }, true);
	}
	writeJson(paths.config(), config);
};

const job = (id: string, status: string) => {
	mkdirSync(paths.jobs(), { recursive: true });
	writeFileSync(join(paths.jobs(), `${id}.json`), JSON.stringify({ id, kind: "reply", status, created: "2026-10-22T00:00:00.000Z", targets: ["youtube"], reply: { platform: "youtube", comment_id: "c1", text: "고마워요" } }));
};

const card = async (f: ReturnType<typeof fakeCtx>) => {
	const r = await run(f.ctx, []);
	expect(r.code).toBe(0);
	expect(r.lines).toHaveLength(1);
	return JSON.parse(r.lines[0]!) as Record<string, string>;
};

test("before setup it prints the single status line and makes no call", async () => {
	const f = fakeCtx();
	expect(await card(f)).toEqual({ 상태: BEFORE_SETUP });
	expect(f.calls).toHaveLength(0);
});

test("connected card shows the stats and the draft and scheduled counts", async () => {
	connect("both");
	job("j-202610220000-0001", "draft");
	job("j-202610220000-0002", "draft");
	job("j-202610220000-0003", "scheduled");
	job("j-202610220000-0004", "done");
	const f = fakeCtx();
	const out = await card(f);

	expect(out).toEqual({ "유튜브 구독자": "1,234", "유튜브 영상": "42", "인스타 팔로워": "56", "인스타 게시물": "7", "답 기다리는 초안": "2개", "예약된 게시": "1개" });
	expect(readFileSync(paths.stats(), "utf8")).not.toMatch(new RegExp(Object.values(SECRETS).join("|")));
});

test("stats refresh at most hourly, then fall back to the cache with (캐시) when the API fails", async () => {
	connect("both");
	const f = fakeCtx();
	await card(f);
	const calls = f.calls.length;

	f.state.subscribers = "9999";
	f.advance(HOUR - 1000);
	expect((await card(f))["유튜브 구독자"]).toBe("1,234");
	expect(f.calls).toHaveLength(calls);

	f.advance(2000);
	f.state.offline = true;
	const stale = await card(f);
	expect(stale["유튜브 구독자"]).toBe("1,234 (캐시)");
	expect(stale["인스타 팔로워"]).toBe("56 (캐시)");

	f.state.offline = false;
	expect((await card(f))["유튜브 구독자"]).toBe("9,999");
});

test("offline with no cache still prints valid JSON", async () => {
	connect("both");
	const f = fakeCtx();
	f.state.offline = true;
	const out = await card(f);
	expect(out["유튜브 구독자"]).toBe("(불러오지 못했어요)");
	expect(out["인스타 팔로워"]).toBe("(불러오지 못했어요)");
	expect(out["답 기다리는 초안"]).toBe("0개");
});

test("a platform that is not connected shows a 연결 note instead of its numbers", async () => {
	connect("instagram");
	const out = await card(fakeCtx());
	expect(out["인스타 팔로워"]).toBe("56");
	expect(out).not.toHaveProperty("유튜브 구독자");
	expect(out["연결"]).toContain("유튜브");
	expect(out["연결"]).not.toContain("인스타");
});

test("the output never contains a secret", async () => {
	connect("both");
	const f = fakeCtx();
	const r = await run(f.ctx, []);
	for (const s of Object.values(SECRETS)) expect(r.lines.join("\n")).not.toContain(s);
});
