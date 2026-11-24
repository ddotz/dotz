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
/** A refused or failed dotz auto-update as its card shows it (hub/selfupdate.ts): the release step ("" for new commits with no release), why, the number of new commits
 *  and the newest one's subject; `halfway` when the rollback failed too: the commit the files are left at and the terminal command that puts them back. */
export type AutoUpdateFacts = { failed: boolean; rel: string; why: string; commits: number; latest: string; halfway?: { at: string; undo: string } };
/** A failed harness install as its card shows it (hub/update.ts): the versions, what it is on now and how it got there (`moved`: no rollback, but the install changed the version),
 *  and the installer's last output line or its exit code. */
export type HarnessFailFacts = { current: string; latest: string; now: string; kept: "untouched" | "moved" | "rolledBack" | "notRolledBack"; output: string };
type OrchKind = "timeout" | "dns" | "network" | "overload" | "crash" | "other";
const ORCH_KINDS_EN: Record<OrchKind, string> = { dns: "The network (DNS) is down", timeout: "The model connection keeps timing out", network: "The network connection keeps dropping", overload: "The model server stays busy", crash: "The assistant process keeps dying", other: "The model keeps failing" };
const HARNESS_NAMES_EN: Record<string, string> = { omo: "work program" };
const ANSWER = /^\s*(?:\*\*)?(\d)\)\s*(.*?)(?:\*\*)?\s*$/s;

/** The option of a gateway card that `text` answers: `n) <label>` as the web, a Discord button or the owner sends it (bold or not, with the note the web
 *  adds after " - "), where each entry of `labels` holds the card's option labels in one language; undefined for any other text, a label's prefix included. */
export function cardAnswer(text: string, labels: string[][]): number | undefined {
	const [, n, said = ""] = ANSWER.exec(text) ?? [];
	const at = Number(n) - 1;
	return labels.some(l => l[at] !== undefined && (said === l[at] || said.startsWith(`${l[at]} - `))) ? at + 1 : undefined;
}
const LEGACY_NAMES_EN: Record<string, string> = { "youtube-oauth.json": "YouTube", "instagram.json": "Instagram" };
const LEGACY_NAMES_KO: Record<string, string> = { "youtube-oauth.json": "유튜브", "instagram.json": "인스타그램" };

/** The cards the gateway writes for a failed schedule run (hub/schedule-fire.ts), a repeated correction (hub/reflect.ts), a recipe (hub/recipes.ts), a pinned account
 *  at its limit (hub/accounts-api.ts), a stopped orchestrator (hub/orch-error.ts), a restart past its cap (hub/restart.ts), a refused or failed self-update
 *  (hub/selfupdate.ts), a failed harness install (hub/update.ts) and the earlier YouTube/Instagram login (hub/migrations.ts), with the rows around them, in English. */
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
	accountLimit: {
		question: (account: string, at: string) => `The pinned account ${account} hit its usage limit, so work pauses until ${at}.`,
		subject: (account: string) => `${account} limit`,
		questionTitle: "Switch to automatic?",
		until: (at: string) => `The limit clears at ${at}`,
		pinned: "It is pinned, so requests do not move to another account",
		others: (n: number) => (n ? `${n} other account(s) can be used now` : "Every other account is blocked right now too"),
		switchChoice: "Switch to automatic",
		switchChoiceNote: "Moves to another usable account and continues right away; the pin is lifted and later limits switch without asking. Settings → Accounts pins it again, and At a limit changes that.",
		waitChoice: "Keep waiting",
		waitChoiceNote: (at: string) => `Keeps the pin and continues once the limit clears at ${at}; the next limit waits without asking. Settings → Accounts, At a limit, changes that.`,
		tomorrow: (clock: string) => `tomorrow ${clock}`,
		onDay: (month: string, day: string, clock: string) => `${month}/${day} ${clock}`,
		wait: (account: string, at: string) => `Waiting while the limit lasts. The limit on ${account} clears at ${at}, and the work continues then.`,
		switched: (to: string) => `The limit was reached, so it moved to ${to} and continues on automatic.`,
		anotherAccount: "another account",
		waitAnswer: "I will keep waiting. Work continues as soon as the limit clears.",
	},
	orchError: {
		lead: (name: string) => `[ask] ${name}: the orchestrator has stopped.`,
		assistant: "Assistant",
		question: "Restart it?",
		since: (at: string) => `Stopped since ${at}`,
		what: (e: { kind: OrchKind; text: string }) => ORCH_KINDS_EN[e.kind],
		retried: "Its automatic retries all failed",
		restart: "Restart",
		restartResult: "Restarts only the orchestrator and handles each unanswered request once more, oldest first.",
		wait: "Wait",
		waitResult: "Leaves it for now; once the model server answers again it restarts by itself, once.",
	},
	restartCap: {
		lead: "The gateway restart is waiting on work that still runs.",
		subject: "Gateway restart",
		question: "Restart now?",
		waited: (min: number) => `Waiting for ${min} min`,
		running: (names: string) => `Still running: ${shorten(names, 100)}`,
		lane: (title: string, workers?: string) => `session ${title}${workers ? ` (${workers} worker(s))` : ""}`,
		work: (kind: string, n?: string) => (n ? `${n} ${kind === "jobs" ? "job(s)" : "worker(s)"}` : kind),
		main: (work: string) => `main chat ${work}`,
		conv: (title: string, work?: string) => `chat ${title}${work ? ` ${work}` : ""}`,
		reply: "a reply being sent",
		held: "New workers are held until the restart",
		pending: "Changed code takes effect only after the restart",
		now: "Restart now",
		nowResult: "Cuts the running work and restarts at once, like Restart now in Settings → Updates; sessions continue after the restart.",
		wait: "Wait for the work",
		waitResult: "Cuts nothing and restarts by itself as soon as the running work ends.",
	},
	selfUpdate: {
		lead: (failed: boolean): string => (failed ? "The dotz auto-update failed." : "dotz did not auto-update."),
		subject: "dotz update",
		question: "Look into the cause?",
		evidence: (u: AutoUpdateFacts) => [
			u.rel ? `Version ${u.rel}: ${u.failed ? "could not be applied" : "blocked, not applied"}` : u.failed ? "The new commits could not be applied" : "The new commits were blocked, not applied",
			u.failed ? "Why: applying it failed; the update log has the reason" : "Why: blocked before applying; the update log has the reason",
			...(u.halfway
				? [`The update stopped halfway: the files are at the new version ${u.halfway.at}`, `To put it back, run in a terminal: \`${u.halfway.undo}\``]
				: [u.commits ? `${u.commits} new commit(s)${u.latest ? `, newest: ${shorten(u.latest, 60)}` : ""}` : "", u.failed ? "The current version stays; a newer release is tried again" : "The current version stays; it is checked again daily"]),
		],
		check: "Find the cause",
		checkResult: "Reads the update log and the repository state and tells you the cause and how to fix it.",
		off: "Turn off auto-update",
		offResult: "Turns off automatic apply so you only get new-version notices. Settings → Updates, Apply updates automatically, turns it back on.",
	},
	harnessUpdate: {
		name: (id: string, label: string) => HARNESS_NAMES_EN[id] ?? label,
		lead: (name: string) => `The ${name} update could not be installed.`,
		subject: (name: string) => `${name} update`,
		question: "Install again?",
		evidence: (h: HarnessFailFacts) => [
			`Version ${h.current} → ${h.latest} could not be installed`,
			h.kept === "untouched" ? `Still on ${h.now}` : h.kept === "moved" ? `Version changed: was ${h.current}, now ${h.now}` : h.kept === "rolledBack" ? `Rolled back to the earlier version (now ${h.now})` : `Could not roll back to the earlier version (now ${h.now})`,
			`Last output: ${shorten(h.output, 80)}`,
		],
		retry: "Install again",
		retryResult: "Installs once more now and reports the result; a failed install keeps the version it has.",
		later: "Leave it until the next check",
		laterResult: "Stays on this version and tries again at tomorrow's early-morning check.",
	},
	legacy: {
		lead: "[ask] Found the earlier YouTube/Instagram connection.",
		subject: "YouTube/Instagram login",
		question: "Bring it over?",
		found: (names: string[]) => `Found: ${names.map(n => LEGACY_NAMES_EN[n] ?? n).join(", ")}`,
		where: "In the earlier setup's folder; this install has none yet",
		notYet: "Nothing is copied before your answer",
		yes: "Bring it over",
		yesResult: "Copies the earlier login files into this install (permission 0600) without showing their values anywhere; the earlier files stay.",
		no: "Do not bring it over",
		noResult: "Copies nothing and does not ask again; to bring them over later, send where the earlier files are in the chat.",
	},
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
	accountLimit: {
		question: (account, at) => `고정한 계정 ${account}: 한도에 걸려서 ${at}까지 멈춰요.`,
		subject: account => `${account} 한도`,
		questionTitle: "자동 전환으로 바꿀까요?",
		until: at => `${at}에 한도가 풀려요`,
		pinned: "고정했으니 다른 계정으로 넘어가지 않아요",
		others: n => (n ? `지금 쓸 수 있는 다른 계정이 ${n}개 있어요` : "다른 계정도 지금은 모두 막혀 있어요"),
		switchChoice: "자동 전환으로 바꾸기",
		switchChoiceNote: "쓸 수 있는 다른 계정으로 넘어가 바로 이어서 해요. 고정은 풀리고, 다음 한도에도 묻지 않고 넘어가요. 설정 → 계정에서 다시 고정하고, '한도에 걸리면'에서 바꿀 수 있어요.",
		waitChoice: "그대로 기다리기",
		waitChoiceNote: at => `고정한 채로 ${at}에 풀리면 이어서 해요. 다음 한도에도 묻지 않고 기다리고, 설정 → 계정의 '한도에 걸리면'에서 바꿀 수 있어요.`,
		tomorrow: clock => `내일 ${clock}`,
		onDay: (month, day, clock) => `${month}월 ${day}일 ${clock}`,
		wait: (account, at) => `한도에 걸린 동안 기다려요. ${account}의 한도는 ${at}에 풀리고, 그때 이어서 해요.`,
		switched: to => `한도에 걸려서 ${to} 넘어갔어요. 자동 전환으로 이어서 해요.`,
		anotherAccount: "다른 계정으로",
		waitAnswer: "한도가 풀릴 때까지 그대로 기다릴게요. 풀리면 이어서 해요.",
	},
	orchError: {
		lead: name => `[ask] ${name}: 오케스트레이터가 멈춰 있어요.`,
		assistant: "어시스턴트",
		question: "다시 시작할까요?",
		since: at => `${at}부터 멈춰 있어요`,
		what: e => e.text,
		retried: "자동 재시도가 모두 실패했어요",
		restart: "다시 시작",
		restartResult: "오케스트레이터만 다시 시작하고, 답하지 못한 요청을 오래된 것부터 한 번씩 다시 처리해요.",
		wait: "기다리기",
		waitResult: "지금은 그대로 두고, 모델 서버가 다시 답하면 한 번 저절로 다시 시작해요.",
	},
	restartCap: {
		lead: "게이트웨이 재시작이 돌고 있는 작업을 기다리고 있어요.",
		subject: "게이트웨이 재시작",
		question: "지금 재시작할까요?",
		waited: min => `${min}분째 기다리고 있어요`,
		running: names => `아직 도는 작업: ${shorten(names, 100)}`,
		lane: (title, workers) => `세션 ${title}${workers ? ` (워커 ${workers}개)` : ""}`,
		work: (kind, n) => `${kind === "jobs" ? "작업" : "워커"}${n ? ` ${n}개` : ""}`,
		main: work => `메인 대화 ${work}`,
		conv: (title, work) => `대화 ${title}${work ? ` ${work}` : ""}`,
		reply: "보내는 중인 답",
		held: "재시작할 때까지 새 워커는 막아 두었어요",
		pending: "바뀐 코드는 재시작해야 적용돼요",
		now: "지금 재시작",
		nowResult: "돌던 작업을 끊고 바로 다시 시작해요. 설정 → 업데이트의 '지금 재시작'과 같고, 세션은 재시작 뒤 이어서 해요.",
		wait: "계속 기다리기",
		waitResult: "아무것도 끊지 않고, 돌던 작업이 끝나는 대로 저절로 재시작해요.",
	},
	selfUpdate: {
		lead: failed => (failed ? "dotz 자동 업데이트를 하지 못했어요." : "dotz 자동 업데이트를 하지 않았어요."),
		subject: "dotz 업데이트",
		question: "원인을 확인할까요?",
		evidence: u => [
			u.rel ? `버전 ${u.rel}: ${u.failed ? "적용하지 못했어요" : "막혀서 적용하지 않았어요"}` : u.failed ? "새 커밋을 적용하지 못했어요" : "새 커밋이 막혀서 적용하지 않았어요",
			u.why ? `이유: ${shorten(u.why.split("\n")[0]!, 100)}` : "",
			...(u.halfway
				? [`업데이트가 중간에 멈췄어요. 파일은 새 버전 ${u.halfway.at}에 있어요`, `되돌리려면 터미널에서: \`${u.halfway.undo}\``]
				: [u.commits ? `새 커밋 ${u.commits}개${u.latest ? `, 마지막: ${shorten(u.latest, 60)}` : ""}` : "", u.failed ? "지금 버전 그대로예요. 더 새 버전이 오면 다시 시도해요" : "지금 버전 그대로예요. 매일 다시 확인해요"]),
		],
		check: "원인 확인",
		checkResult: "업데이트 로그와 저장소 상태를 보고 원인과 고칠 방법을 알려드려요.",
		off: "자동 업데이트 끄기",
		offResult: "자동 적용을 꺼서 새 버전 알림만 받아요. 설정 → 업데이트의 '새 버전 자동 적용'으로 다시 켤 수 있어요.",
	},
	harnessUpdate: {
		name: (_id, label) => label,
		lead: name => `${name} 업데이트를 설치하지 못했어요.`,
		subject: name => `${name} 업데이트`,
		question: "다시 설치해 볼까요?",
		evidence: h => [
			`버전 ${h.current} → ${h.latest} 설치하지 못했어요`,
			h.kept === "untouched" ? `지금 ${h.now} 그대로예요` : h.kept === "moved" ? `버전이 바뀌었어요: 설치 전 ${h.current}, 지금 ${h.now}` : h.kept === "rolledBack" ? `이전 버전으로 되돌렸어요 (지금 ${h.now})` : `이전 버전으로 되돌리지 못했어요 (지금 ${h.now})`,
			`마지막 출력: ${shorten(h.output, 80)}`,
		],
		retry: "다시 설치해 봐요",
		retryResult: "지금 한 번 더 설치하고 결과를 알려드려요. 실패하면 지금 버전을 그대로 둬요.",
		later: "다음 점검까지 둬요",
		laterResult: "지금 버전으로 두고, 내일 새벽 점검 때 다시 시도해요.",
	},
	legacy: {
		lead: "[ask] 예전 유튜브·인스타 연결을 찾았어요.",
		subject: "예전 유튜브·인스타 연결",
		question: "가져올까요?",
		found: names => `찾은 연결: ${names.map(n => LEGACY_NAMES_KO[n] ?? n).join(", ")}`,
		where: "예전 설정 폴더에 있고, 이 설치에는 아직 없어요",
		notYet: "답을 받기 전에는 아무것도 복사하지 않아요",
		yes: "가져오기",
		yesResult: "예전 설정의 연결 파일을 이 컴퓨터로 복사해요 (권한 0600). 값은 어디에도 보여 주지 않고, 예전 파일은 그대로 남아요.",
		no: "안 가져오기",
		noResult: "복사하지 않고 다시 묻지 않아요. 나중에 가져오려면 예전 파일 위치를 대화로 보내면 돼요.",
	},
};
