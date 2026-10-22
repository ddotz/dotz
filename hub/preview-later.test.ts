// The `[later]` sentinel (a turn handed to a background worker) never reaches a preview, a chat line or a push, and the push
// badge is a white-on-transparent alpha mask the hub serves.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { emitEventActivity } from "./activity.ts";
import { previewOf } from "./conversations.ts";
import { activityItems } from "./events.ts";
import { classify } from "./push.ts";
import { makeRoute } from "./routes.ts";
import { LATER_LINE } from "./tone.ts";

const WEB = join(import.meta.dir, "..", "web");
const web = (f: string) => readFileSync(join(WEB, "js", f), "utf8");
const cut = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));

test("hub preview: [later] is a friendly line, status markers and Ask labels are dropped", () => {
	expect(previewOf("[later]")).toBe(LATER_LINE);
	expect(previewOf("  [later]\n")).toBe(LATER_LINE);
	expect(previewOf("[done] 체크리스트 5개를 모두 완료로 표시했어요")).toBe("체크리스트 5개를 모두 완료로 표시했어요");
	expect(previewOf("Ask: dotz에 카톡 연동을 넣고 싶어요")).toBe("dotz에 카톡 연동을 넣고 싶어요");
	expect(previewOf("Ask: 해줘 - wanted: 끝. For you: 요약. Now: a. Next: b.\n\n실제 본문입니다")).toBe("실제 본문입니다");
	expect(LATER_LINE).not.toContain("later");
});

test("a [later] turn end is no activity row, and a push never carries it", () => {
	emitEventActivity("later-test", { type: "activity", row: { type: "text", text: "[later]" } } as never);
	emitEventActivity("later-test", { type: "activity", row: { type: "text", text: "맡겼어요" } } as never);
	expect(activityItems("later-test").map(a => (a as { text: string }).text)).toEqual(["맡겼어요"]);
	const ev = (text: string) => ({ ts: "2026-10-22T00:00:00Z", kind: "out", source: "orchestrator", target: "web", text });
	expect(classify(ev("[later]") as never, 10 * 60_000)).toBeUndefined();
	expect(classify({ ...ev("Ask: 정리해 줘 - wanted: 끝. For you: 다 했어요. Now: x. Next: y."), source: "lane:a", lane: "a", text: "[done] 정리를 마쳤어요" } as never)?.body).toBe("정리를 마쳤어요");
});

// The web page's own rule, run from the real source (08-home.js, 13-data.js).
function page() {
	const tone = cut(web("02-basic-markdown.js"), "const TONE_TAGS", "/* ---------- api");
	const home = cut(web("08-home.js"), "// The runtime's status rows", "function laneLastFetch") + cut(web("08-home.js"), "// Same rule as hub/tone.ts stripHandoff", "function askOf") + cut(web("08-home.js"), "// A preview line shows", "function askOf");
	const conv = cut(web("31-conversations.js"), "// Same rule as hub/conversations.ts previewOf", "function convLastOf");
	const data = cut(web("13-data.js"), "function ingestAct", "async function loadTarget");
	const TS: Record<string, { acts: unknown[]; ak: Set<string>; cap: number }> = {};
	const env = {
		oneLine: (s: unknown) => String(s).replace(/\s+/g, " ").trim().slice(0, 160),
		toolLineKo: () => "", target: "web", MAIN: "web", CV: { full: false }, isProjT: () => false, chatPush: () => {}, termPush: () => {},
		ts: (t: string) => TS[t] ?? (TS[t] = { acts: [], ak: new Set(), cap: 100 }), TS,
		targetOfSource: () => "web", actKey: (a: { ts: string }) => a.ts,
	};
	const names = Object.keys(env);
	const api = new Function(...names, `${tone}\n${home}\n${conv}\n${data}\nreturn { actLine, convPreview, friendlyLine, ingestAct };`)(...names.map(n => (env as Record<string, unknown>)[n])) as {
		actLine: (a: unknown) => string; convPreview: (s: string) => string; friendlyLine: (s: string) => string; ingestAct: (a: unknown) => void;
	};
	return { ...api, TS };
}

test("web: the same lines in home rows, session lists and the chat", () => {
	const p = page();
	for (const f of [p.friendlyLine, p.convPreview, (s: string) => p.actLine({ type: "text", text: s })]) {
		expect(f("[later]")).toBe(LATER_LINE);
		expect(f("[done] 체크리스트 5개를 모두 완료로 표시했어요")).toBe("체크리스트 5개를 모두 완료로 표시했어요");
		expect(f("Ask: dotz에 처음엔 꺼져 있는 카톡 연동을 넣고")).toBe("dotz에 처음엔 꺼져 있는 카톡 연동을 넣고");
		expect(f("[later]")).not.toMatch(/later/i);
	}
	p.ingestAct({ ts: "1", type: "text", source: "orchestrator", text: "[later]" });
	p.ingestAct({ ts: "2", type: "text", source: "orchestrator", text: "네, 맡겼어요" });
	expect(p.TS.web!.acts).toEqual([{ ts: "2", type: "text", source: "orchestrator", text: "네, 맡겼어요" }]);
});

// 8-bit RGBA, non-interlaced PNG -> alpha and colour per pixel.
function decodeRgba(file: Buffer): { w: number; h: number; px: Uint8Array } {
	expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	let w = 0, h = 0;
	const idat: Buffer[] = [];
	for (let o = 8; o < file.length; ) {
		const len = file.readUInt32BE(o), type = file.toString("ascii", o + 4, o + 8), body = file.subarray(o + 8, o + 8 + len);
		if (type === "IHDR") {
			w = body.readUInt32BE(0);
			h = body.readUInt32BE(4);
			expect([body[8], body[9], body[12]]).toEqual([8, 6, 0]);
		}
		if (type === "IDAT") idat.push(body);
		o += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, px = new Uint8Array(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)]!;
		for (let i = 0; i < stride; i++) {
			const a = i >= 4 ? px[y * stride + i - 4]! : 0, b = y ? px[(y - 1) * stride + i]! : 0, c = y && i >= 4 ? px[(y - 1) * stride + i - 4]! : 0;
			const x = raw[y * (stride + 1) + 1 + i]!;
			const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
			px[y * stride + i] = (x + pred) & 255;
		}
	}
	return { w, h, px };
}

test("the push badge is a white-on-transparent alpha mask with a ring-and-dot silhouette, served by the hub", async () => {
	const file = readFileSync(join(WEB, "icons", "badge-96.png"));
	const { w, h, px } = decodeRgba(file);
	expect([w, h]).toEqual([96, 96]);
	let clear = 0, solid = 0;
	for (let i = 0; i < px.length; i += 4) {
		const a = px[i + 3]!;
		if (a === 0) clear++;
		else if (a > 0) {
			if (a === 255) solid++;
			expect([px[i], px[i + 1], px[i + 2]]).toEqual([255, 255, 255]);
		}
	}
	const total = w * h, at = (x: number, y: number) => px[(y * w + x) * 4 + 3]!;
	expect(clear / total).toBeGreaterThan(0.4); // not an opaque square
	expect(solid / total).toBeGreaterThan(0.15);
	expect([at(0, 0), at(95, 0), at(0, 95), at(95, 95)]).toEqual([0, 0, 0, 0]); // corners clear
	expect(at(48, 48)).toBe(255); // dot
	expect(at(48, 21)).toBe(0); // gap between dot and ring
	expect(at(48, 10)).toBe(255); // ring
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const res = await route(new Request("http://x/icons/badge-96.png"));
	expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
	expect(Buffer.from(await res.arrayBuffer()).equals(file)).toBe(true);
	const sw = readFileSync(join(WEB, "sw.js"), "utf8");
	expect(sw).toMatch(/badge: "\/icons\/badge-96\.png"/);
	expect(sw).toMatch(/icon: "\/icons\/icon-192\.png"/);
});
