/** The longest card title, `<subject> · <question>`, in characters: the owner reads it whole on his phone. */
export const TITLE_CHARS = 40;

const width = (s: string): number => [...s].length;

/** `one` within `max` characters, cut at a word boundary and ended with "…"; `cutAlready` marks a text already cut, which keeps its "…". */
export function shorten(one: string, max: number, cutAlready = false): string {
	const chars = [...one];
	if (chars.length <= max && !cutAlready) return one;
	if (chars.length < max) return `${one}…`;
	const head = chars.slice(0, max - 1).join(""), space = chars[max - 1] === " " ? head.length : head.lastIndexOf(" ");
	return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** A card subject that fits TITLE_CHARS with its question and `tag` (what tells apart two cards that would read the same): the quote in it ('…') is shortened at a word boundary first, then the subject's end. */
export function fitSubject(subject: string, question: string, tag = ""): string {
	const room = TITLE_CHARS - width(question) - 3 - width(tag), over = width(subject) - room;
	if (over <= 0) return `${subject}${tag}`;
	const open = subject.indexOf("'"), close = subject.lastIndexOf("'"), inner = subject.slice(open + 1, close);
	if (open < 0 || close <= open || width(inner) - over < 2) return `${shorten(subject, room)}${tag}`;
	return `${subject.slice(0, open + 1)}${shorten(inner.replace(/…$/, ""), width(inner) - over, inner.endsWith("…"))}${subject.slice(close)}${tag}`;
}

const TOPIC_LABELS_EN: Record<string, string> = { linebreak: "line breaks", copy: "copy and tone", "no-card": "questions without a card", duplicate: "duplicate features", stalled: "stalls and lost reports", misread: "misread instructions", "missing-output": "output not visible", ui: "screens and design", "ignored-setting": "ignored settings", "not-applied": "not applied or half verified", other: "other" };
const TOPIC_LABELS_KO: Record<string, string> = { linebreak: "줄바꿈", copy: "문체·카피", "no-card": "카드 없는 질문", duplicate: "기능 중복", stalled: "멈춤·보고 끊김", misread: "지시 오해", "missing-output": "산출물 안 보임", ui: "화면·디자인", "ignored-setting": "설정 불이행", "not-applied": "미반영·반쯤 검증", other: "기타" };

type Repeat = { topic: string; count: number; broken: number; examples: string[] };
type RecipeDraft = { name: string; when: string; script?: { file: string } };

/** The cards the gateway writes for a failed schedule run (hub/schedule-fire.ts), a repeated correction (hub/reflect.ts) and a recipe (hub/recipes.ts), with the rows around them, in English. */
export const cardsEn = {
	scheduleRun: {
		running: "Running now.",
		nothing: "Nothing to tell this time.",
		posted: "The result is in the conversation.",
		held: (name: string) => `${name}: waiting on the model usage limit. It starts as soon as the limit lifts.`,
		failed: (name: string) => `${fitSubject(name, "Run it again?")} · Run it again?`,
		failedWhen: (when: string) => `No result came from the run of ${when}.`,
		rerun: "Run again",
		rerunResult: "Runs this schedule once more now, as a new run.",
		stop: "Leave it",
		stopResult: "This run stays failed; the schedule itself stays as it is.",
	},
	repeatAlertSubject: (a: Repeat) => (a.topic === "other" && a.examples[0] ? a.examples[0] : (TOPIC_LABELS_EN[a.topic] ?? a.topic)),
	repeatAlertEvidence: (a: Repeat) => [a.count ? `${a.count} in 7 days` : "", a.broken ? `A lesson broken on ${a.broken} nights` : "", a.examples[0] ? `For example: ${a.examples[0]}` : ""].filter(Boolean),
	repeatAlertQuestion: "Add a guard?",
	repeatAlertOptions: [{ name: "Add a guard", result: "A guard, check or test that stops this comes next; it starts only after this answer." }, { name: "Leave it this week", result: "No card on this topic for 7 days; if it still comes back after that, you are asked again." }],
	recipeCard: (d: RecipeDraft, preview: string) => [preview, ...(d.script ? [`Script: ${d.script.file}`] : [])].filter(Boolean).join("\n"),
	recipeEvidence: (d: RecipeDraft, titles: string[]) => [`Use when: ${d.when}`, `From: ${titles.join(" / ")}`],
	recipeQuestion: "Save as a recipe?",
	recipeOptions: [{ name: "Save recipe", result: "Stored only in this install's custom/recipes, found by name when similar work comes. It never runs by itself; deleting its folder removes it." }, { name: "Skip recipe", result: "Nothing is stored and the same work is not proposed again." }],
};

/** The same cards in Korean. */
export const cardsKo: typeof cardsEn = {
	scheduleRun: {
		running: "돌아가는 중이에요",
		nothing: "알릴 게 없었어요",
		posted: "결과를 대화에 올렸어요",
		held: name => `${name}: 모델 사용량 한도로 기다리는 중이에요. 풀리면 바로 시작해요.`,
		failed: name => `${fitSubject(name, "다시 실행할까요?")} · 다시 실행할까요?`,
		failedWhen: when => `${when} 실행에서 결과를 받지 못했어요.`,
		rerun: "다시 실행",
		rerunResult: "이 예약을 지금 새 실행으로 한 번 더 돌려요.",
		stop: "그만두기",
		stopResult: "이번 실행은 실패로 두고, 예약은 그대로 둬요.",
	},
	repeatAlertSubject: a => (a.topic === "other" && a.examples[0] ? a.examples[0] : (TOPIC_LABELS_KO[a.topic] ?? a.topic)),
	repeatAlertEvidence: a => [a.count ? `7일간 ${a.count}건` : "", a.broken ? `교훈이 ${a.broken}번 깨졌어요` : "", a.examples[0] ? `예: ${a.examples[0]}` : ""].filter(Boolean),
	repeatAlertQuestion: "막는 장치를 만들까요?",
	repeatAlertOptions: [{ name: "막는 장치 만들기", result: "되풀이를 막는 가드·검사·테스트를 만들어요. 이 답을 받은 뒤에만 시작해요." }, { name: "이번 주는 그냥 두기", result: "7일 동안 이 주제로 카드를 올리지 않아요. 그 뒤에도 되풀이되면 다시 물어요." }],
	recipeCard: (d, preview) => [preview, ...(d.script ? [`스크립트: ${d.script.file}`] : [])].filter(Boolean).join("\n"),
	recipeEvidence: (d, titles) => [`쓸 때: ${d.when}`, `근거: ${titles.join(" / ")}`],
	recipeQuestion: "레시피로 저장할까요?",
	recipeOptions: [{ name: "레시피 저장", result: "이 설치의 custom/recipes에만 저장하고, 비슷한 일을 할 때 이름으로 찾아 써요. 저절로 돌지 않고, 그 폴더를 지우면 없어져요." }, { name: "레시피 건너뛰기", result: "저장하지 않고 같은 일은 다시 제안하지 않아요." }],
};
