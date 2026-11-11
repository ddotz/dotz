import { expect, test } from "bun:test";
import { type HubEvent, emit, onEmit } from "./events.ts";
import { deriveSpec, resolveSpecFence } from "./message-spec-derive.ts";
import { specOf } from "./message-spec-of.ts";
import { type SpecElement, specChildren, specOfElements, specPlain, validateSpec, webUrl } from "./message-spec.ts";
import { ownerText } from "./owner-text.ts";

const el = (type: string, props: Record<string, unknown>): SpecElement => ({ type, props });
const lead = el("Text", { text: "먼저 한 줄이에요." });
// One spec of each component, tried above an evidence line: words and basic markdown alone are conversation, which has no spec.
const EACH: Record<string, SpecElement[]> = {
	Text: [lead, el("Bullets", { ordered: false, items: [{ text: "하나" }, { text: "둘" }] })],
	Heading: [el("Heading", { text: "제목" })],
	Bullets: [el("Bullets", { ordered: true, items: [{ text: "가" }, { text: "나", sub: true }], head: "순서" })],
	Steps: [el("Steps", { items: ["열기", "누르기"], head: "방법" })],
	Schedule: [el("Schedule", { rows: [{ time: "09:30", text: "회의" }, { time: "14:00", text: "점검" }] })],
	Facts: [el("Facts", { rows: [{ key: "응답", from: "5,308ms", to: "36ms" }, { key: "상태", value: "정상" }] })],
	Section: [el("Section", { title: "빌드", rows: [{ key: "서버", count: "3회", value: "통과" }, { key: "웹", from: "9s", to: "3s" }] })],
	Table: [el("Table", { head: ["이름", "값"], rows: [["a", "1"], ["b", "2"]] })],
	Rows: [el("Rows", { title: "대화방", rows: [{ title: "가족", sub: "단체", meta: "20:58", badge: "2" }, { title: "Alex" }] })],
	Sources: [el("Sources", { head: "출처", items: [{ href: "https://example.com/a", title: "예시" }, { href: "https://example.com/b" }] })],
	Quote: [el("Quote", { lines: ["인용 한 줄", "둘째 줄"] })],
	Meta: [el("Meta", { text: "작은 줄" })],
	Evidence: [el("Evidence", { items: ["파일 A", "로그 B"] })],
	Code: [el("Code", { code: "const a = 1;", lang: "ts" })],
	Rule: [lead, el("Rule", {})],
	Choice: [el("Choice", { question: "어느 쪽으로 할까요?", options: [{ n: 1, label: "이쪽", desc: "빠르게" }, { n: 2, label: "저쪽" }] })],
	Files: [el("Files", { items: [{ path: "/tmp/a.txt" }, { path: "docs/b.md" }] })],
};

test("deriveSpec reads back what specPlain wrote, for one spec of each component", () => {
	for (const [name, els] of Object.entries(EACH)) {
		const spec = specOfElements(name === "Evidence" ? els : [...els, el("Evidence", { items: ["로그"] })]);
		expect(validateSpec(spec).ok, name).toBe(true);
		expect(deriveSpec(specPlain(spec)), name).toEqual(spec);
	}
});

test("a whole answer comes out as its blocks in order", () => {
	const text = "결론부터 말할게요.\n\n1. 열기\n2. 누르기\n\n**빌드**\n- **서버:** 통과\n- **웹:** 9s → 3s\n\n| 이름 | 값 |\n|---|---|\n| a | 1 |\n\n```ts\nlet x;\n```\n\n---\n\n근거: 로그 · 파일";
	expect(specChildren(deriveSpec(text)!).map(e => e.type)).toEqual(["Text", "Steps", "Section", "Table", "Code", "Rule", "Evidence"]);
});

test("Code keeps its language, 원문 and dotz-settings included", () => {
	const spec = deriveSpec("```원문\nraw\n```\n\n```dotz-settings\n{}\n```\n\n근거: 로그");
	expect(specChildren(spec!).map(e => e.props.lang)).toEqual(["원문", "dotz-settings", undefined]);
});

test("conversation stays plain, and nothing throws", () => {
	expect(deriveSpec("네, 알겠어요. 바로 할게요.")).toBeNull();
	expect(deriveSpec("첫 줄\n\n둘째 줄")).toBeNull();
	expect(deriveSpec("할 일이에요.\n\n- 사과 사기\n- 전화하기")).toBeNull();
	for (const bad of ["", "   ", "```", "|", "- ", "1.", "\0", "**", "> ", "[file]", "근거:", "결정:", undefined as unknown as string, 42 as unknown as string]) expect(() => deriveSpec(bad)).not.toThrow();
});

test("a draft approval is left exactly as it is", () => {
	const ref = "> 받는 사람: 김\n> 안녕하세요\n\n결정: 이 답글을 보낼까요? (draft-12ab)\n**1) 보내기**\n바로 보내요\n**2) 고치기**\n고쳐 달라고 해요\n**3) 보내지 않기**\n버려요";
	expect(deriveSpec(ref)).toBeNull();
	expect(deriveSpec("> 초안 줄\n\n결정: 보낼까요?\n**1) 보내기**\n바로\n**2) 고치기**\n고쳐요")).toBeNull();
	expect(deriveSpec("결정: 어느 쪽으로 할까요?\n**1) 이쪽**\n빠르게\n**2) 저쪽**\n천천히")).not.toBeNull();
});

test("a message over the limits is no spec", () => {
	expect(deriveSpec(Array.from({ length: 260 }, (_, i) => `- 항목 ${i}`).join("\n"))).toBeNull();
	expect(deriveSpec(`- 하나\n- ${"가".repeat(21_000)}`)).toBeNull();
});

const SPEC_JSON = JSON.stringify(specOfElements([el("Steps", { items: ["열기", "누르기"] })]));

test("a valid dotz-spec fence becomes its plain form", () => {
	expect(resolveSpecFence(`앞 문장\n\n\`\`\`dotz-spec\n${SPEC_JSON}\n\`\`\`\n\n뒤 문장`)).toBe("앞 문장\n\n1. 열기\n2. 누르기\n\n뒤 문장");
});

test("an unknown component or a bad spec keeps the readable strings, a non-JSON fence stays a code block", () => {
	const odd = JSON.stringify({ v: 1, root: "m", elements: { m: { type: "Message", props: {}, children: ["a"] }, a: { type: "Carousel", props: { title: "읽을 말", items: ["둘", "셋"] } } } });
	expect(resolveSpecFence(`\`\`\`dotz-spec\n${odd}\n\`\`\``)).toBe("읽을 말\n둘\n셋");
	const broken = "```dotz-spec\n{not json\n```";
	expect(resolveSpecFence(broken)).toBe(broken);
	expect(resolveSpecFence("```ts\nlet a;\n```")).toBe("```ts\nlet a;\n```");
	expect(resolveSpecFence("평범한 글")).toBe("평범한 글");
});

test("specOf resolves the fence first, and ownerText does it for emit and Discord", () => {
	const fenced = `\`\`\`dotz-spec\n${SPEC_JSON}\n\`\`\``;
	expect(specChildren(specOf(fenced)!).map(e => e.type)).toEqual(["Steps"]);
	expect(ownerText(`끝났어요.\n\n${fenced}`)).toBe("끝났어요.\n\n1. 열기\n2. 누르기");
});

test("emit stores the spec of an answer only, and leaves its text alone", () => {
	const seen: HubEvent[] = [];
	onEmit(e => void (e.source === "spec-test" && seen.push(e)));
	const body = "정리했어요.\n\n- **응답:** 5,308ms → 36ms\n- **상태:** 정상";
	const at = () => new Date().toISOString();
	emit("outbox", { ts: at(), kind: "out", source: "spec-test", text: `[done] ${body}` });
	emit("outbox", { ts: at(), kind: "out", source: "spec-test", text: "네, 했어요." });
	emit("outbox", { ts: at(), kind: "out", source: "spec-test", relay: true, text: body });
	emit("outbox", { ts: at(), kind: "out", source: "spec-test", update_key: "progress", text: body });
	emit("outbox", { ts: at(), kind: "lane_report", source: "spec-test", text: body });
	emit("outbox", { ts: at(), kind: "message", source: "spec-test", text: body });
	expect(seen.map(e => (e.spec ? specChildren(e.spec as ReturnType<typeof specOfElements>).map(c => c.type).join("+") : ""))).toEqual(["Status+Text+Facts", "", "", "", "Text+Facts", ""]);
	expect(seen[0]!.text).toBe(`[done] ${body}`);
});

// Owner 2026-11-09: a status mark must not show as plain text. The bot's contract allows [done] and ✅ alike, and the answers of that day began "✅ …" and "[ask] ✅ …".
test("a leading status mark, marker or emoji, is the Status in front on every answer path, and messengers keep the text as written", () => {
	const body = "정리했어요.\n\n- **응답:** 5,308ms → 36ms\n- **상태:** 정상";
	const at = () => new Date().toISOString();
	const sent: HubEvent[] = [
		{ ts: at(), kind: "out", source: "orchestrator", target: "main", text: `✅ ${body}` },
		{ ts: at(), kind: "out", source: "orchestrator", target: "ch:1", text: `[ask] ✅ ${body}` },
		{ ts: at(), kind: "lane_report", source: "lane:audit", lane: "audit", text: `❌ ${body}` },
		{ ts: at(), kind: "out", source: "orchestrator", target: "worklog", text: `확인됨 · ✅ ${body}` },
		{ ts: at(), kind: "out", source: "orchestrator", target: "main", text: "⏸️ 답을 기다려요." },
		{ ts: at(), kind: "out", source: "orchestrator", target: "main", text: "네, 했어요." },
	];
	for (const e of sent) emit("outbox", e);
	const head = (e: HubEvent) => (e.spec ? specChildren(e.spec as ReturnType<typeof specOfElements>).slice(0, 2).map(c => [c.type, c.props.tone ?? c.props.text]) : null);
	expect(sent.map(head)).toEqual([
		[["Status", "done"], ["Text", "정리했어요."]],
		[["Status", "ask"], ["Text", "정리했어요."]],
		[["Status", "fail"], ["Text", "정리했어요."]],
		[["Status", "done"], ["Text", "정리했어요."]],
		null,
		null,
	]);
	expect(specPlain(sent[0]!.spec as ReturnType<typeof specOfElements>)).toStartWith("[done] 정리했어요.\n\n- ");
	expect(validateSpec(specOfElements([el("Status", { tone: "later" })])).ok).toBe(false);
	expect(specChildren(specOf(`✅ ${body}`)!)[0]).toEqual(el("Text", { text: "✅ 정리했어요." }));
});

test("a meta line for the bot needs the bot's own name", () => {
	const text = "정리했어요.\n\n1. 열기\n2. 닫기\n\n- 봇이 몫: 정리\n- 오너 몫: 확인";
	const kinds = (bot: string) => specChildren(deriveSpec(text, bot)!).map(e => e.type);
	expect(kinds("봇이")).toEqual(["Text", "Steps", "Meta", "Bullets"]);
	expect(kinds("")).toEqual(["Text", "Steps", "Facts"]);
});

test("a numbered list under a question stays text for a surface: its buttons read that text", () => {
	const text = "두 가지가 있어요.\n\n어떻게 할까요?\n1) 그대로 두기\n2) 고치기";
	expect(deriveSpec(text)).not.toBeNull();
	expect(specOf(text)).toBeNull();
	expect(specOf("정리했어요.\n\n1. 열기\n2. 닫기")).not.toBeNull();
	expect(specOf("결정: 어느 쪽으로 할까요?\n**1) 이쪽**\n빠르게\n**2) 저쪽**\n천천히")).not.toBeNull();
});

test("a link with a control character in it is not a web link", () => {
	expect(webUrl("https://a.example/x")).toBe(true);
	expect(webUrl("https://a.example/\u001b]0;x\u0007")).toBe(false);
	expect(webUrl("https://a.example/\u009b1m")).toBe(false);
});
