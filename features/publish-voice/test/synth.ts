// Synthetic Korean sentences for the tests. Written for this repo; nothing here comes from a real person's writing.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDoc, type DocRec } from "../lib/profile.ts";
import type { Deps } from "../lib/deps.ts";

export type Kind = "opinion" | "story" | "guide" | "authorA" | "authorB";

const NOUNS = ["동네 도서관", "자전거길", "마을 시장", "공원 벤치", "버스 노선", "골목 가게", "강변 산책로", "주민 센터"];
const PLACES = ["문화관", "체육관", "시민 회관", "작은 도서관"];
const TEMPLATES: Record<Kind, readonly string[]> = {
	opinion: [
		"{N}은 우리 사회에 꼭 필요하다고 생각합니다.", "하지만 {N}을 둘러싼 논쟁은 아직 끝나지 않았습니다.", "그러나 비용만 따지는 것은 문제입니다.",
		"왜냐하면 {N}은 한 번 무너지면 되돌리기 어렵기 때문입니다.", "{N}에 대한 투자는, 결국 모두에게 돌아옵니다.", "우리는 이제 선택해야 합니다.",
		"과연 {N} 없이 도시가 버틸 수 있을까요?", "저는 이 문제를 오래 지켜봤습니다.",
	],
	story: [
		"나는 {N}에 갔다.", "비가 오고 있었다.", "그래서 우산을 폈다.", "골목 끝에서 오래된 간판을 보았다.", "잠시 멈춰 서서 숨을 골랐다.",
		"{N} 앞에는 아무도 없었다.", "그날의 공기는 조금 차가웠다.",
	],
	guide: [
		"{N} 안내입니다.", "3월 5일 오후 2시에 {P}에서 모임이 있습니다.", "참석하시려면 신청서를 제출해 주세요.", "문의는 사무실로 연락하세요.",
		"준비물은 필기도구입니다.", "접수는 3월 3일에 마감합니다.",
	],
	authorA: [
		"{N}은 오래전부터 이 동네 사람들이 조용히 지켜 온 자리이고, 앞으로도 그렇게 이어질 것이라고 생각합니다.",
		"그러나 그 자리를 지키는 일은 생각보다 많은 시간과 손길을 필요로 하며, 누구도 혼자서는 해낼 수 없습니다.",
		"우리가 해야 할 일은 거창한 계획을 세우는 것이 아니라, 매일 같은 시간에 같은 자리를 살피는 것입니다.",
	],
	authorB: ["{N} 갔어요!", "진짜 좋았어요~", "또 가고 싶어요.", "다들 와요!", "{N} 최고예요~"],
};

const seeded = (seed: number) => {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
};

export function synth(kind: Kind, sentences: number, seed: number): string {
	const rnd = seeded(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] ?? xs[0] as T;
	const lines = Array.from({ length: sentences }, () => pick(TEMPLATES[kind]).replaceAll("{N}", pick(NOUNS)).replaceAll("{P}", pick(PLACES)));
	const paragraphs: string[] = [];
	for (let i = 0; i < lines.length; i += 4) paragraphs.push(lines.slice(i, i + 4).join(" "));
	return paragraphs.join("\n\n");
}

export function sized(kind: Kind, minChars: number, seed: number): string {
	let n = Math.max(4, Math.floor(minChars / 30));
	let text = synth(kind, n, seed);
	while (text.replace(/\s/g, "").length < minChars) text = synth(kind, (n += Math.ceil(n / 20)), seed);
	return text;
}

export const docsOf = (kind: Kind, count: number, minChars: number, source: DocRec["source"] = "folder"): DocRec[] =>
	Array.from({ length: count }, (_, i) => makeDoc({ id: `${kind}${i}`, origin: "scope", source, text: sized(kind, minChars, i + 1) }));

export function tempDir(prefix = "pv-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(dir: string, files: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

export const noDeps = (data: string): Deps => ({
	run: async argv => {
		throw new Error(`이 시험에서는 프로세스를 부르지 않아요: ${argv.join(" ")}`);
	},
	fetchText: async url => {
		throw new Error(`이 시험에서는 네트워크를 쓰지 않아요: ${url}`);
	},
	data,
});
