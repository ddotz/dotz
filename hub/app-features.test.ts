import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_FEATURES, featureEnabled, featuresOf, internalOf, ownedWatches, retryInternal, setFeature, watchOwner } from "./app-features.ts";
import { watchOff } from "./app-off.ts";
import { readSettings } from "./app-settings.ts";
import { appEntries } from "./integrations.ts";
import { PEER_GET } from "./peer-auth.ts";
import { createPeerMonitor } from "./peer-monitor.ts";
import type { Watch } from "./watch.ts";

// Every function an app has is the app's own: features with switches, and the watches, login keepers and syncs it owns. The mapping is data
// (registry + feature declarations + instance filter), so these tests use only placeholder names.
const data = mkdtempSync(join(tmpdir(), "app-features-"));
afterAll(() => rmSync(data, { recursive: true, force: true }));
const put = (rel: string, v: unknown) => {
	mkdirSync(join(data, rel, ".."), { recursive: true });
	writeFileSync(join(data, rel), JSON.stringify(v));
};
put("custom/sns/config.json", { instagram: {}, youtube: {} });
put("custom/apps.json", { "mail-2": { app: "mail", label: "회사", filter: { source: "work", watches: ["work-mail-login"] } } });

const watch = (name: string, extra: Partial<Watch> = {}, state: Partial<Watch["state"]> = {}): Watch => ({ name, command: "true", every_minutes: 60, state: { fails: 0, ...state }, ...extra }) as unknown as Watch;
const keeper = (name: string, url: string, state: Partial<Watch["state"]> = {}) => watch(name, { session: { url, refresh_hours: 6 } }, state);
const W = [
	watch("sns-ig-comments", {}, { lastRun: "2026-10-23T01:00:00.000Z" }),
	keeper("ig-site-login", "https://www.instagram.com/accounts/login", { lastRun: "2026-10-23T01:00:00.000Z", fails: 2, last: "session expired", kind: "auth" }),
	keeper("yt-studio-login", "https://studio.youtube.com/"),
	watch("kakao-new"),
	watch("webmail-naver", {}, { lastRun: "2026-10-23T01:00:00.000Z" }),
	watch("work-mail-login", { session: { url: "https://mail.example.com/", refresh_hours: 6 } }),
	watch("plain-disk-check"),
];

describe("ownership: a watch belongs to one app", () => {
	const entries = appEntries(data);
	test("by registry name or prefix", () => {
		expect(watchOwner(entries, W[0]!)).toBe("instagram");
		expect(watchOwner(entries, W[3]!)).toBe("kakao");
		expect(watchOwner(entries, W[4]!)).toBe("mail");
	});
	test("a login keeper by the site it keeps, not by its name", () => {
		expect(watchOwner(entries, W[1]!)).toBe("instagram");
		expect(watchOwner(entries, W[2]!)).toBe("youtube");
	});
	test("an instance's filter.watches wins over the default instance, and the default does not take it", () => {
		expect(watchOwner(entries, W[5]!)).toBe("mail-2");
	});
	test("a watch no app claims stays with 일반 모니터링", () => {
		expect(watchOwner(entries, W[6]!)).toBeUndefined();
		expect([...ownedWatches(data, W).entries()].sort()).toEqual([["instagram", ["sns-ig-comments", "ig-site-login"]], ["kakao", ["kakao-new"]], ["mail", ["webmail-naver"]], ["mail-2", ["work-mail-login"]], ["youtube", ["yt-studio-login"]]].sort());
	});
	test("an app switched off pauses the watches it owns, a login keeper by site too", () => {
		put("custom/apps.json", { instagram: { off: true }, "mail-2": { app: "mail", filter: { watches: ["work-mail-login"] } } });
		expect(watchOff(data, "sns-ig-comments")).toBe(true);
		expect(watchOff(data, "ig-site-login", { url: "https://www.instagram.com/x" })).toBe(true);
		expect(watchOff(data, "plain-disk-check")).toBe(false);
		put("custom/apps.json", { "mail-2": { app: "mail", label: "회사", filter: { source: "work", watches: ["work-mail-login"] } } });
	});
});

describe("features view", () => {
	test("lists only what the API and the feature folder do; the rest is declared, hidden", () => {
		const v = featuresOf(data, "instagram", W, []);
		expect(v.features.map(f => f.id)).toEqual(["comment_reply", "reels_approval", "dm_read"]);
		expect(APP_FEATURES.instagram!.features.filter(f => f.ready === false).map(f => f.id)).toEqual(["post_edit", "dm"]);
		expect(featuresOf(data, "youtube", W, []).features.map(f => f.name)).toEqual(["자동 초안", "메타데이터", "쇼츠·영상 올리기 승인"]);
	});
	test("login keeper and sync are internal rows with status dot, last run and the failure in Korean", () => {
		const v = featuresOf(data, "instagram", W, []);
		expect(v.internal.map(i => [i.id, i.kind, i.dot])).toEqual([["sns-ig-comments", "sync", "ok"], ["ig-site-login", "login", "fail"]]);
		expect(v.internal.map(i => i.every_minutes)).toEqual([60, 60]);
		// A feature whose switch is a settings key names that key and its section, so the screen draws the control once.
		expect(v.features.map(f => [f.id, f.setting ?? null, f.section ?? null])).toEqual([["comment_reply", "auto_draft", "draft"], ["reels_approval", null, "draft"], ["dm_read", null, "more"]]);
		const login = v.internal[1]!;
		expect(login.name.startsWith("로그인 유지")).toBe(true);
		expect(login.status).toBe("2번 연달아 실패했어요");
		expect(login.last_run).toBe("2026-10-23T01:00:00.000Z");
		expect(login.reason).toBeTruthy();
		expect(/[가-힣]/.test(login.reason!)).toBe(true);
		expect(featuresOf(data, "kakao", W, []).internal.map(i => [i.id, i.dot])).toEqual([["kakao-new", "idle"]]);
	});
	test("the YouTube app lists the bulk apply with its progress and a login renewal that failed with the reason", () => {
		const ran = "2026-10-23T01:00:00.000Z";
		const sns = [
			watch("sns-yt-bulk", { label: "유튜브 다국어 설명 적용" }, { lastRun: ran, last: "다국어 설명 2/3개 적용했어요" }),
			watch("sns-yt-login", { label: "유튜브 로그인 유지" }, { lastRun: ran, fails: 1, kind: "auth", last: "DOTZ_FAIL auth\n유튜브 로그인을 6일째에 다시 받지 못했어요" }),
		];
		const rows = featuresOf(data, "youtube", sns, []).internal;
		expect(rows.map(r => [r.id, r.dot, r.status])).toEqual([["sns-yt-bulk", "ok", "다국어 설명 2/3개 적용했어요"], ["sns-yt-login", "fail", "1번 연달아 실패했어요"]]);
		expect(rows[1]!.reason).toContain("6일째");
		expect(rows[0]!.name).toContain("다국어 설명");
	});
	test("a feature switch persists in custom/apps.json, per instance, and a switch bound to a setting writes the setting", () => {
		expect(featureEnabled(data, "instagram", "reels_approval")).toBe(true);
		setFeature(data, "instagram", "reels_approval", false);
		expect(JSON.parse(readFileSync(join(data, "custom/apps.json"), "utf8")).instagram.features).toEqual({ reels_approval: false });
		expect(featureEnabled(data, "instagram", "reels_approval")).toBe(false);
		const row = featuresOf(data, "instagram", W, []).features.find(f => f.id === "reels_approval")!;
		expect([row.on, row.status]).toEqual([false, "꺼져 있어요"]);
		setFeature(data, "instagram", "reels_approval", true);
		expect(JSON.parse(readFileSync(join(data, "custom/apps.json"), "utf8")).instagram).toEqual({});
		setFeature(data, "instagram", "comment_reply", true);
		expect(readSettings(data, "instagram").find(s => s.key === "auto_draft")!.value).toBe(true);
		expect(featuresOf(data, "instagram", W, []).features.find(f => f.id === "comment_reply")!.on).toBe(true);
		expect(JSON.parse(readFileSync(join(data, "custom/apps.json"), "utf8"))["mail-2"].label).toBe("회사");
	});
	test("a not-ready or unknown feature has no switch", () => {
		expect(() => setFeature(data, "instagram", "dm", true)).toThrow("알 수 없는 기능");
		expect(() => setFeature(data, "instagram", "reels_approval", "yes")).toThrow("true 또는 false");
		expect(() => featuresOf(data, "nope", W, [])).toThrow("알 수 없는 앱");
	});
	test("approvals are listed in the app they belong to, with the feature that asks", () => {
		const draft = { to: "x", subject: "s", body: "b" };
		const n = (id: string, title: string, text: string, state = "open") => ({ id, title, text, decision: { state, to: "main", draft } });
		const notices = [n("a1", "릴스 올리기 승인 (j-1)", "인스타 릴스 영상이에요"), n("a2", "인스타 댓글 답글 (j-2)", "인스타 댓글에 답해요"), n("y1", "영상 올리기 승인 (j-3)", "유튜브 쇼츠예요"), n("a3", "릴스 이미 처리 (j-4)", "인스타", "answered")];
		const ig = featuresOf(data, "instagram", W, notices);
		expect(ig.approvals.map(a => a.id)).toEqual(["a1", "a2"]);
		expect(ig.approvals.map(a => a.feature)).toEqual(["reels_approval", "reels_approval"]);
		expect(featuresOf(data, "youtube", W, notices).approvals.map(a => [a.id, a.feature])).toEqual([["y1", "upload_approval"]]);
		expect(featuresOf(data, "instagram", W, notices).features.find(f => f.id === "reels_approval")!.status).toBe("승인 대기 2건");
	});
	test("a Reels approval says it cannot publish yet while the token lacks the publish permission", () => {
		const draft = { to: "x", subject: "s", body: "b" };
		const notices = [{ id: "a1", title: "릴스 올리기 승인 (j-1)", text: "인스타 릴스 영상이에요", decision: { state: "open", to: "main", draft } }];
		const flag = join(data, "custom/sns/cache/ig-publish.json");
		expect(featuresOf(data, "instagram", W, notices).approvals[0]!.note).toBeUndefined();
		put("custom/sns/cache/ig-publish.json", { missing: true });
		try {
			const v = featuresOf(data, "instagram", W, notices);
			expect(v.approvals[0]!.note).toContain("instagram_business_content_publish");
			expect(v.features.find(f => f.id === "reels_approval")!.status).toContain("아직 릴스를 올릴 수 없어요");
			expect(featuresOf(data, "youtube", W, notices).approvals).toEqual([]);
		} finally {
			rmSync(flag, { force: true });
		}
	});
	test("다시 시도 runs only a watch the app owns", async () => {
		const ran: string[] = [];
		await retryInternal(data, "instagram", "ig-site-login", W, async n => void ran.push(n));
		expect(ran).toEqual(["ig-site-login"]);
		await expect(retryInternal(data, "instagram", "kakao-new", W, async n => void ran.push(n))).rejects.toThrow("내부 기능이 아니에요");
		expect(ran).toEqual(["ig-site-login"]);
	});
	test("다시 연결 of a watch behind an approval gate approves it (the tap is the owner's yes) instead of a plain run that only waits", async () => {
		const ran: string[] = [], approved: string[] = [];
		const gated = W.map(w => (w.name === "ig-site-login" ? { ...w, approval_minutes: 30 } : w));
		await retryInternal(data, "instagram", "ig-site-login", gated, async n => void ran.push(n), n => void approved.push(n));
		expect([ran, approved]).toEqual([[], ["ig-site-login"]]);
	});
	test("a watch that exits 0 but says it is logged out (DOTZ_DISCONNECTED) is a down row with 다시 연결, not 정상", () => {
		const w = watch("kdb-login");
		const down = internalOf({ ...w, state: { ...w.state, fails: 0, lastRun: "2026-10-27T00:18:50.593Z", last: "waiting for the owner's approval\nDOTZ_DISCONNECTED since=2026-10-23T12:29:18.300Z" } }, "메일");
		expect([down.dot, down.down, down.status]).toEqual(["fail", true, "연결이 끊겼어요 · 다시 로그인이 필요해요"]);
		const ok = internalOf({ ...w, state: { ...w.state, fails: 0, lastRun: "2026-10-27T00:18:50.593Z", last: "not waiting" } }, "메일");
		expect([ok.dot, ok.down]).toEqual(["ok", undefined]);
	});
});

describe("a peer gets the same through /api/peer/proxy and /api/peer/act", () => {
	const seen: { method: string; path: string; body: unknown }[] = [];
	const pm = createPeerMonitor({
		name: () => "A",
		computers: async () => [],
		local: async req => {
			seen.push({ method: req.method, path: new URL(req.url).pathname, body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.json() });
			return Response.json({ ok: true });
		},
	});
	const act = (args: unknown) => pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action: "app", from: "B", args }) }), new URL("http://local/api/peer/act"));
	test("the features read is a peer read; the switch and the retry are acts on the owning machine", async () => {
		expect(PEER_GET.some(r => r.test("/api/integrations/instagram/features"))).toBe(true);
		await act({ op: "features", app: "instagram", id: "reels_approval", on: false });
		await act({ op: "retry", app: "instagram", watch: "ig-site-login" });
		expect(seen).toEqual([
			{ method: "PATCH", path: "/api/integrations/instagram/features", body: { id: "reels_approval", on: false } },
			{ method: "POST", path: "/api/integrations/instagram/retry", body: { watch: "ig-site-login" } },
		]);
	});
	test("초안 작성 of a peer's mail is a POST of its draft route on the owning machine", async () => {
		seen.length = 0;
		await pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action: "mail-draft", from: "B", args: { key: "kdb-66943118" } }) }), new URL("http://local/api/peer/act"));
		expect(seen.map(s => [s.method, s.path])).toEqual([["POST", "/api/mail/kdb-66943118/draft"]]);
	});
	test("감시 삭제 of a peer's monitor is a DELETE of the watch on the owning machine", async () => {
		seen.length = 0;
		await pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action: "watch", from: "B", args: { op: "delete", name: "login-cartier-com" } }) }), new URL("http://local/api/peer/act"));
		expect(seen.map(s => [s.method, s.path])).toEqual([["DELETE", "/api/watches/login-cartier-com"]]);
	});
});

describe("owner-facing text has no internal key or id", () => {
	const RAW = /[a-z]+-[0-9]|_|\b(?:sns|ig|yt|site|each|batch|comments|login)\b/;
	const view = featuresOf(data, "instagram", W, [
		{ id: "a1", title: "릴스 올리기 승인 (j-1)", text: "인스타 릴스", decision: { state: "open", to: "main", draft: { to: "x", subject: "", body: "주말 여행 릴스예요 #여행 길게 길게 길게 길게 길게 길게 길게 길게 길게 길게 길게 길게 길게 길게" }, options: [{ n: 1, label: "올리기" }, { n: 2, label: "고치기" }, { n: 3, label: "그만두기" }] } },
		{ id: "a2", title: "릴스 올리기 승인 (j-2)", text: "인스타", decision: { state: "open", to: "main", draft: { to: "x", subject: "", body: "" } } },
	]);
	test("internal rows are named from the watch label or what the watch does, never its key", () => {
		expect(view.internal.map(i => i.name)).toEqual(["동기화 · 댓글 가져오기", "로그인 유지 · 인스타그램 로그인"]);
		const own = internalOf(watch("sns-ig-comments", { label: "댓글 확인" }), "인스타그램");
		expect(own.name).toBe("동기화 · 댓글 확인");
		expect(internalOf(watch("sns-ig-comments", { label: "ig site 로그인" } as Partial<Watch>), "인스타그램").name).toBe("동기화 · 댓글 가져오기");
		expect(internalOf(watch("odd-thing"), "인스타그램").name).toBe("동기화 · 인스타그램 새 소식 확인");
	});
	test("an approval is titled by its item (caption start, no id) and carries the answers except 고치기", () => {
		expect(view.approvals[0]!.title.startsWith("주말 여행 릴스예요")).toBe(true);
		expect(view.approvals[0]!.title.length).toBeLessThanOrEqual(60);
		expect(view.approvals[0]!.options).toEqual([{ n: 1, label: "올리기" }, { n: 3, label: "그만두기" }]);
		expect(view.approvals[1]!.title).toBe("릴스 올리기 승인");
	});
	test("everything the rows say passes the raw-key check; the approval-mode setting reads 하나씩 승인", () => {
		const said = [...view.features.flatMap(f => [f.name, f.status]), ...view.internal.flatMap(i => [i.name, i.status]), ...view.approvals.flatMap(a => [a.title, a.kind ?? "", ...a.options.map(o => o.label)])];
		for (const s of said) expect(s).not.toMatch(RAW);
		const f = readSettings(data, "instagram").find(s => s.key === "approval")!;
		expect(f.labels).toEqual({ each: "하나씩 승인", batch: "모아서 승인" });
		expect(f.help).not.toMatch(RAW);
	});
});

describe("a peer approval is answered with the peer's own decision", () => {
	test("/api/peer/act answer goes to that computer's notice answer route", async () => {
		const seen: { method: string; path: string; body: unknown }[] = [];
		const pm = createPeerMonitor({ name: () => "A", computers: async () => [], local: async req => (seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json() }), Response.json({ ok: true })) });
		await pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action: "answer", from: "B", args: { id: "a1", n: 3 } }) }), new URL("http://local/api/peer/act"));
		expect(seen).toEqual([{ method: "POST", path: "/api/notices/a1/answer", body: { n: 3, via: "B" } }]);
	});
	test("/api/peer/act notice reads, ignores and un-ignores on that computer's notice routes", async () => {
		const seen: { path: string; body: unknown }[] = [];
		const pm = createPeerMonitor({ name: () => "A", computers: async () => [], local: async req => (seen.push({ path: new URL(req.url).pathname, body: await req.json() }), Response.json({ ok: true })) });
		const act = (args: object) => pm.route(new Request("http://local/api/peer/act", { method: "POST", body: JSON.stringify({ action: "notice", from: "B", args }) }), new URL("http://local/api/peer/act"));
		await act({ op: "read", ids: ["n1", 2] });
		await act({ op: "ignore", id: "n3" });
		await act({ op: "unignore", id: "n3" });
		expect((await act({ op: "drop", id: "n3" }))!.status).toBe(400);
		expect(seen).toEqual([{ path: "/api/notices/read", body: { ids: ["n1", "2"] } }, { path: "/api/notices/n3/ignore", body: {} }, { path: "/api/notices/n3/unignore", body: {} }]);
	});
});
