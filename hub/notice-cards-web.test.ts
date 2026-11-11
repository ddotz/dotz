import { afterAll, expect, test } from "bun:test";
import { now } from "./config.ts";
import { listNotices, NOTICE_CAP } from "./notices.ts";
import { feed } from "./notices-store.ts";
import { fakeHub, json } from "./test-web.ts";
import { watchChoice } from "./watch.ts";
import { watchLine } from "./watchtext.ts";

// The other report kinds, as the store makes them from the gateway's events (neutral fixture text): in the 감시 소식 feed a folded row says the
// counts and the first changed line, never a section heading joined in; on the 알림 screen a watch row does not repeat its name, a JSON report reads
// in Korean words, a long log says how many lines and when the last one was, a recovery is tagged as one, and a failure's question says what failed.
const base = Date.parse(now()) - 60 * 60_000;
let i = 0;
const ts = () => new Date(base + ++i * 60_000).toISOString();
const W = (label: string, reason: string, text: string, prev: string) => feed({ ts: ts(), kind: "watch", source: "gateway", watch: `card-${i}`, label, reason, text, prev } as never);
const log = (s: number) => Array.from({ length: 30 }, (_, k) => `2025-01-02T01:${String(k + s).padStart(2, "0")}:00Z INFO worker job=sync step=${k + s}`).join("\n");
W("재고 목록", "output changed", "샘플 상품 A 재고 1개\n샘플 상품 B 품절", "샘플 상품 A 재고 3개\n샘플 상품 B 재고 2개");
W("상태 JSON", "output changed", JSON.stringify({ status: "ok", count: 3, latest: { title: "샘플 항목" } }), "{}");
W("동기화 로그", "output changed", log(10), log(0));
W("새 메일 확인", "match", "DOTZ_ITEM mail:sample/1\nsubject: 샘플 제목\nfrom: 샘플 보낸이 <sender@example.com>", "");
feed({ ts: ts(), kind: "out", source: "gateway", target: "alert", text: `${watchLine("가격 확인", "failed 2 times in a row (exit 1)", "DOTZ_FAIL fetch")}\n${watchChoice("가격 확인", "failed 2 times in a row (exit 1)")}` } as never);
feed({ ts: ts(), kind: "out", source: "gateway", target: "alert", text: watchLine("사이트 상태 확인", "recovered", "ok") } as never);
const items = listNotices(NOTICE_CAP).items.filter(n => Date.parse(n.at ?? n.ts) >= base);
const id = (title: string) => items.find(n => n.title === title || n.text.startsWith(title))!.id;

const hub = fakeHub({
	stream: "fake",
	api: (_req, url) => {
		if (url.pathname === "/api/notices") return json({ items, unread: 0 });
		if (url.pathname === "/api/monitors") return json({ items: [] });
	},
});
afterAll(() => hub.stop());

const drawn = (v: Awaited<ReturnType<typeof hub.view>>, sel: string, read: string) =>
	v.evaluate(`new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error(${JSON.stringify(`not drawn: ${sel}`)})), 10000);
		const tick = () => document.querySelector(${JSON.stringify(sel)}) ? (clearTimeout(t), res(JSON.stringify(${read}))) : requestAnimationFrame(tick);
		tick();
	})`).then(s => JSON.parse(s as string));

test("folded feed rows say the counts and the first changed line (390px)", async () => {
	const v = await hub.view({ width: 390, height: 900 });
	await v.navigate(`${hub.origin}/#monitoring/notice`);
	const sum = (t: string) => `monSummary(NT.items.find(n => n.id === "${id(t)}"), [])`;   // the line a folded row (.fr-sum) shows
	const got = await drawn(v, `#mon-tl [data-nid="${id("재고 목록")}"]`, `[${sum("재고 목록")}, ${sum("상태 JSON")}, ${sum("동기화 로그")}]`);
	expect(got).toEqual(["새 항목 2건 · 사라진 항목 2건 · 샘플 상품 A 재고 1개", "결과가 바뀌었어요 · 상태: 정상", "결과가 바뀌었어요 · 기록 30줄 · 마지막 1월 2일 오전 10:39"]);
}, 30_000);

test("알림 rows say what happened without the name twice (390px)", async () => {
	const v = await hub.view({ width: 390, height: 1200 });
	await v.navigate(`${hub.origin}/#notices`);
	const row = (t: string) => `(r => r && [r.querySelector(".hd").textContent, r.querySelector(".nsc-s").textContent, r.querySelector(".tag").textContent])(document.querySelector('#v-notices .nsc-r[data-nid="${id(t)}"]'))`;
	const fail = items.find(n => n.kind === "decision")!.id;
	const got = await drawn(v, "#v-notices .nsc-r", `[${row("재고 목록")}, ${row("상태 JSON")}, ${row("사이트 상태 확인")}, ${row("새 메일 확인")}, (r => r.querySelector(".hd").textContent)(document.querySelector('#v-notices .nsc-r[data-nid="${fail}"]'))]`);
	expect(got).toEqual([
		["재고 목록", "새 항목 2건 · 사라진 항목 2건 · 샘플 상품 A 재고 1개", "감시"],
		["상태 JSON", "결과가 바뀌었어요 · 상태: 정상", "감시"],
		["사이트 상태 확인: 다시 정상이에요", "점검이 다시 통과했어요", "복구"],
		["새 메일 확인", "샘플 제목", "메일"],
		"가격 확인: 2번 연속 실패했어요. 어떻게 할까요?",
	]);
}, 30_000);
