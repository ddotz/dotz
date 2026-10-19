// Language of the instructions the gateway sends to its agents (orchestrator and lanes). The language is the identity's
// (config.json identity.language, set by setup; detected from the identity text when unset). English and Korean have
// originals below; any other language gets the English text plus one "Reply to the owner in <language>" line per prompt
// that carries instructions. Bracket tags ([dotz gateway], [handover], [dotz lane <name>], [dotz inbox]) stay literal.
//
// Notes the gateway recognises again later (by prefix) have a `lead` in every language; `isNote` matches against all of
// them, so a language change mid-session (or a pending.json written under another language) still matches.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, IDENTITY_FILE, NAME, paths } from "./config.ts";
import { baseLanguage, detectLanguage, languageName } from "./language.ts";

export type LaneFooterArgs = { lane: string; mode: string; workerModel: string; slots: number; worktree: string };
export type WorktreeArgs = { path: string; repo: string; branch: string; base: string };
export type RecallArgs = { mode: string; identity: string; rules: string; lessons: string; setups: string; state: string };

// Prefixes (leads) of notes that are matched later; every note that has a lead starts with it.
const enLeads = {
	youAre: "[dotz gateway] You are",
	replayLead: "[dotz gateway] The gateway restarted before you answered this",
	newMessageLead: "[dotz gateway] A new message arrived while you are working",
	waitedLead: "[dotz gateway] The owner has waited",
	rateLead: "[dotz gateway] The rate limit has passed",
	providerLead: "[dotz gateway] The provider problem (billing/auth) may have been fixed",
	transientLead: "[dotz gateway] The provider had a temporary error (overloaded or network) and your last turn failed",
};
type Leads = typeof enLeads;
const koLeads: Leads = {
	youAre: "[dotz gateway] 당신은",
	replayLead: "[dotz gateway] 게이트웨이가 다시 시작돼서 이 요청에 아직 답하지 못했어요",
	newMessageLead: "[dotz gateway] 작업 중에 새 메시지가 도착했어요",
	waitedLead: "[dotz gateway] 오너가 기다리는 중이에요",
	rateLead: "[dotz gateway] 사용량 한도가 풀렸어요",
	providerLead: "[dotz gateway] 모델 제공자 문제(결제/인증)가 해결됐을 수 있어요",
	transientLead: "[dotz gateway] 모델 제공자에 일시적인 오류(과부하 또는 네트워크)가 있어서 마지막 턴이 실패했어요",
};

const en = {
	...enLeads,

	recall: (a: RecallArgs) => `[dotz gateway] You are ${NAME}, the dotz orchestrator hosted headless by the gateway.\n\nIdentity (who you are and how you talk):\n${a.identity}\n\nContract:\n\n${a.mode}\n\nOwner rules (${paths.rules}; they override the contract):\n${a.rules}\n\nLessons (${paths.lessons}):\n${a.lessons}\n\nWork channel setups (dotz_channel list for login health):\n${a.setups}\n\nCurrent state.json:\n${a.state}`,
	identityFallback: (character: string, tone: string) => `Name: ${NAME}\nCharacter: ${character}\nTone: ${tone}\nSpeak in this character and tone in every reply.`,
	handover: (previous: string, tail: string) => `\n\n[handover] The previous session (${previous}) was rotated to keep the context small. Its most recent exchanges, oldest first; continue any open thread from here:\n${tail}`,
	laneHandover: (previous: string, tail: string | undefined) => `[handover] The previous session (${previous}) was rotated.${tail ? ` Its most recent exchanges, oldest first:\n${tail}` : ""}`,
	keepalive: "[keepalive] Cache keepalive from the gateway. Reply only: ok. No tools, no sends, no state edits.",

	orchRate: (held: number) => `${enLeads.rateLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchProvider: (held: number) => `${enLeads.providerLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchTransient: `${enLeads.transientLead}. Continue the request you were handling when it stopped.`,

	laneStopped: "[dotz gateway] Your process was restarted after it stopped responding. Continue the last request.",
	laneRate: `${enLeads.rateLead}. Continue the work you were doing when it stopped.`,
	laneProvider: `${enLeads.providerLead}. Continue the work you were doing when it stopped.`,
	laneTransient: `${enLeads.transientLead}. Continue the work you were doing when it stopped.`,
	laneOwnerResumed: "[dotz gateway] The owner resumed you. Continue the work you were doing.",
	laneOwnerRestarted: "[dotz gateway] Your process was restarted by the owner (settings changed). Continue the work you were doing.",
	laneMemory: (used: string, limit: string) => `[dotz gateway] Your process used ${used} GB of memory (limit ${limit} GB), so the gateway restarted it on the same session; any task workers you had running stopped too. omp's grep, cat and find run inside your own process: do not point them at huge trees (~, ~/Library, /) or multi-GB files, and quote paths with spaces. Check what your workers finished, relaunch the rest, and continue the work you were doing.`,
	laneGatewayRestarted: "[dotz gateway] The gateway restarted while you were working, which also stopped any task workers you had running. Check what they finished (patches, files, commits), relaunch the rest, and continue; if an owner message was cut off mid-turn, handle it too.",
	laneRotated: (why: string, cwd: string, brief: string, lastReport: string) => `[dotz gateway] Your session was rotated to a fresh one (${why}) to keep the context small. You keep your folder (${cwd}), model and goal. Read your brief (${brief}) and your last report (${lastReport}), check the current state of the work (git status, the files the brief names), and continue from there. Do not start new work and do not report: if nothing is open, reply with the single word "ready".`,
	heldMessages: (text: string, held: string[]) => `${text}\n\n${held.length} owner message(s) arrived while you were paused; handle each, oldest first:\n\n${held.join("\n\n---\n\n")}`,

	footer: (a: LaneFooterArgs) => `\n\n---\n[dotz lane ${a.lane}] You are a lane of ${NAME}: a full omp orchestrator for this folder with one goal. The final message of each turn is your report: ${NAME} relays it and the owner reads it in the lane channel. Keep it to ~800 characters in the report shape of ${a.mode} (Reporting): the first line is the outcome; then, only when the owner must answer something, a **Decision needed** paragraph of numbered questions, each with its options and your recommendation; then at most 3-4 bullets of what changed and how you checked it (paths, the Done-when check you ran yourself, the merged commit); last, one "For ${NAME}:" line for what the orchestrator handles, never mixed with the owner's questions. The owner may write to you directly. Do not message Discord or other people yourself, and never put secrets in a report. Before you start, read and follow ${a.mode} (sections Lanes and workers, Reporting, Browser and testing), ${IDENTITY_FILE} (voice) and the owner's standing rules in ${paths.rules} (they override your defaults). Plan and review yourself; run implementation and grind work as task workers (worker model ${a.workerModel} via modelRoles.task), and review a worker's diff yourself before applying or merging it. Do not queue independent slices behind one worker: this machine runs up to ${a.slots} task workers at once, so fan independent slices (different files, or separable sections merged one by one) out in one batch; keep one worker only for work that must be sequential. Size the work once at the start (heavy: new module, security or permissions, external integration, DB schema, concurrency, cross-domain refactor; unsure is heavy; never downgrade): light = 1-2 success criteria and one proof, heavy = 3+ (happy, edge, regression) with a proof each and a reviewer pass. Passing tests is not done: prove the changed behavior on its real surface (command, screen, API). Take reversible choices inside the request and budget yourself and note them in the report; ask the owner only at the confirmation gates (secrets, payments, external blast radius, destructive steps) or for taste. Write tool-call intents in the owner's language, 2-6 words, and tell your workers the same.${a.worktree}`,
	worktree: (w: WorktreeArgs) => `\n\nYou work in your own git worktree ${w.path} on branch ${w.branch}, split from ${w.repo} (${w.base}); paths under ${w.repo} in your brief mean the same files under ${w.path}. In worker briefs write repo files as paths relative to the worktree: an isolated worker gets its own copy, and an absolute ${w.repo} or ${w.path} path makes it edit the real checkout. Other lanes and the owner work in ${w.repo}: never edit files there. Commit your work on ${w.branch} as you go. Untracked setup (node_modules, .env, build output) is not in the worktree: install or link what you need. When the Done-when check passes, land it the way this project lands work (a PR if it uses them); otherwise rebase onto ${w.base} (\`git rebase ${w.base}\`), then \`git -C ${w.repo} merge --ff-only ${w.branch}\`. On a conflict, resolve it in your worktree and retry; never force, never reset ${w.repo}. Report the merged commit. The gateway removes your worktree when the lane is closed after the merge.`,
	noGit: `\n\nThis folder is not a git repository, so isolated task workers cannot start here: run workers without isolation (read-only work needs none), and if a worker must edit files, keep its slice to files no other worker touches.`,

	replay: `${enLeads.replayLead}. Handle it now; it may be partly done already, so check before repeating an action.`,
	newMessage: (target: string, replyTo: string | undefined, text: string) => `${enLeads.newMessageLead}; it gets no turn of its own. Answer it now with dotz_send target "${target}"${replyTo ? ` reply_to "${replyTo}"` : ""} (the full answer if it is quick, else a short note on when), then continue the current work. Your final answer still goes to the request you started with.\n\n${text}`,
	waited: (seconds: number, target: string) => `${enLeads.waitedLead} ${seconds}s in ${target} with nothing posted there. Post a short progress note in ${target} now (dotz_send update_key "progress": what you are doing, when the answer comes), then carry on.`,
	firstStart: (target: string) => `[dotz gateway] First start of this install. Speak first in ${target}: greet the owner in a few short messages as ${NAME} (who you are, what you can do: channels per project, monitoring, lanes, schedules). Then ask once whether you may learn their setup, read-only: Aside's memory of them (aside memory list / search: who they are, people, projects, sites) and the sites they are signed in to, coding agent sessions and their projects, tools and CLIs in use, logs and schedules on this machine. On yes, do it with read-only workers, keep one progress message updated in place (dotz_send update_key "onboarding"), record what you learn in memory as you go, and end with a short summary of what you learned and what is still missing. On no, just say how to start.`,

	inboxLaneReport: (lane: string) => `[dotz inbox] lane report from ${lane}:`,
	inboxWatchNoChannel: (watch: string, reason: string) => `[dotz inbox] watch ${watch} ${reason} (no one is waiting for this turn; tell the owner with dotz_send only if it matters):`,
	inboxWatch: (watch: string, reason: string, ch: string) => `[dotz inbox] watch ${watch} ${reason} for work channel ch:${ch} (your final answer goes there; reply "-" alone to post nothing):`,
	inboxMail: (ch: string) => `[dotz inbox] new mail for work channel ch:${ch} (your final answer goes there; open one thread per mail titled "<sender> - <subject>" with dotz_channel thread and put the summary there; if a person wants something from the owner, brief them with a suggested reply; read or act with zele, sending only after the owner's OK; reply "-" alone to post nothing):`,
	inboxSchedule: (id: string, every: number | undefined, channel: string) => `[dotz inbox] scheduled (${id}${every ? `, every ${every} min` : ""}) - do it now; your final answer goes to ${channel}:`,
	inboxThread: (thread: string, parent: string) => ` (thread "${thread}" in #${parent}; your answer goes into the thread)`,
	inboxFirst: (channel: string) => `(new work channel #${channel}: the owner hands out work by channel. Keep this channel's work and reports here. If its work needs a login kept alive or something checked over time, set that up for this channel with dotz_channel setup yourself.)`,
	inboxBurst: (n: number) => `(sent as ${n} messages in a row; read them together as one request)`,
	replyingTo: (author: string, content: string) => `(replying to ${author}: "${content}")`,
	workChannels: (list: string[]) => `(work channels: ${list.length ? list.join("; ") : "none yet"})`,

	reflect: (digest: string, lessons: string) => `[dotz reflect] Nightly self-review of the last 24h. Data from the gateway:\n${digest}\n
Do this, briefly:
1. Find what went wrong or cost too much: owner corrections or repeated asks, failed or stuck lanes, alerts, cache rewrites.
2. For each real lesson add or update one dated line in ${lessons} (keep it under ~30 lines; delete lessons that no longer apply or that a rule already covers). Retain durable facts about the owner with your memory tool.
3. If something recurred although RULES.md or LESSONS.md already covers it, more text will not help: send the owner (dotz_send alert) a concrete fix for the carrier (which file, hook, brief footer or check to change).
4. Never edit RULES.md here; propose rule changes to the owner in alert and wait for their answer.
5. Finish with one dotz_send worklog post in the identity's language and Notices style: a first line "Nightly review", then "- " bullets in plain words for what you did (e.g. "- 1 lesson noted in LESSONS.md", "- 1 proposed fix posted to alert"), at most 4 bullets. Nothing else is sent.`,
};
type Catalog = typeof en;

const ko: Catalog = {
	...koLeads,

	recall: a => `[dotz gateway] 당신은 게이트웨이가 헤드리스로 띄운 dotz 오케스트레이터(${NAME})예요.\n\n정체성 (당신이 누구이고 어떻게 말하는지):\n${a.identity}\n\n계약:\n\n${a.mode}\n\n오너 규칙 (${paths.rules}; 계약보다 우선해요):\n${a.rules}\n\n교훈 (${paths.lessons}):\n${a.lessons}\n\n작업 채널 설정 (로그인 상태는 dotz_channel list):\n${a.setups}\n\n현재 state.json:\n${a.state}`,
	identityFallback: (character, tone) => `이름: ${NAME}\n성격: ${character}\n말투: ${tone}\n모든 답을 이 성격과 말투로 하세요.`,
	handover: (previous, tail) => `\n\n[handover] 이전 세션(${previous})은 컨텍스트를 작게 유지하려고 교체했어요. 가장 최근 대화를 오래된 순으로 붙여요. 열려 있는 일이 있으면 여기서 이어가세요:\n${tail}`,
	laneHandover: (previous, tail) => `[handover] 이전 세션(${previous})을 교체했어요.${tail ? ` 가장 최근 대화를 오래된 순으로 붙여요:\n${tail}` : ""}`,
	keepalive: "[keepalive] 게이트웨이의 캐시 유지 신호예요. ok 한 단어로만 답하세요. 도구, 전송, 상태 수정은 하지 마세요.",

	orchRate: held => `${koLeads.rateLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.${held ? ` 멈춰 있는 동안 도착한 메시지 ${held}건이 오래된 순으로 이어서 와요.` : ""}`,
	orchProvider: held => `${koLeads.providerLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.${held ? ` 멈춰 있는 동안 도착한 메시지 ${held}건이 오래된 순으로 이어서 와요.` : ""}`,
	orchTransient: `${koLeads.transientLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.`,

	laneStopped: "[dotz gateway] 프로세스가 응답을 멈춰서 다시 시작했어요. 마지막 요청을 이어서 처리하세요.",
	laneRate: `${koLeads.rateLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	laneProvider: `${koLeads.providerLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	laneTransient: `${koLeads.transientLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	laneOwnerResumed: "[dotz gateway] 오너가 당신을 다시 시작시켰어요. 하던 작업을 이어서 하세요.",
	laneOwnerRestarted: "[dotz gateway] 오너가 설정을 바꿔서 프로세스를 다시 시작했어요. 하던 작업을 이어서 하세요.",
	laneMemory: (used, limit) => `[dotz gateway] 프로세스가 메모리를 ${used}GB 써서(한도 ${limit}GB) 게이트웨이가 같은 세션으로 다시 시작했어요. 실행 중이던 task 워커도 모두 멈췄어요. omp의 grep, cat, find는 당신 프로세스 안에서 돌아요. 아주 큰 폴더(~, ~/Library, /)나 수 GB짜리 파일에 쓰지 말고, 공백이 있는 경로는 따옴표로 감싸세요. 워커가 끝낸 것을 확인하고 나머지는 다시 띄운 뒤 하던 작업을 이어가세요.`,
	laneGatewayRestarted: "[dotz gateway] 작업 중에 게이트웨이가 다시 시작돼서 실행 중이던 task 워커도 모두 멈췄어요. 워커가 끝낸 것(패치, 파일, 커밋)을 확인하고, 나머지는 다시 띄워서 이어가세요. 오너 메시지가 턴 도중에 끊겼다면 그것도 처리하세요.",
	laneRotated: (why, cwd, brief, lastReport) => `[dotz gateway] 컨텍스트를 작게 유지하려고 세션을 새로 바꿨어요 (${why}). 폴더(${cwd}), 모델, 목표는 그대로예요. 브리프(${brief})와 마지막 보고(${lastReport})를 읽고, 작업의 현재 상태(git status, 브리프가 가리키는 파일)를 확인한 뒤 거기서 이어가세요. 새 작업을 시작하거나 보고하지 마세요. 열려 있는 일이 없으면 "ready" 한 단어로만 답하세요.`,
	heldMessages: (text, held) => `${text}\n\n멈춰 있는 동안 오너 메시지 ${held.length}건이 도착했어요. 오래된 순으로 각각 처리하세요:\n\n${held.join("\n\n---\n\n")}`,

	footer: a => `\n\n---\n[dotz lane ${a.lane}] 당신은 ${NAME}의 레인이에요: 목표가 하나인 이 폴더 전용 omp 오케스트레이터예요. 각 턴의 마지막 메시지가 보고예요. 보고는 게이트웨이가 ${NAME}의 이름으로 전달하고, 오너는 레인 채널에서 읽어요. 보고는 800자 안팎으로, ${a.mode}(Reporting)의 보고 형식대로 쓰세요: 첫 줄은 결론. 오너가 답해야 할 게 있을 때만 그다음 문단에 **결정 필요** 아래 번호 질문(질문마다 선택지와 추천). 이어서 바뀐 것과 확인한 것 최대 3-4줄(경로, 직접 돌린 Done-when 확인, 머지 커밋). 마지막에 ${NAME}가 처리할 것은 "${NAME} 몫:" 한 줄로 쓰고, 오너 질문과 섞지 마세요. 오너가 당신에게 직접 쓸 수도 있어요. Discord나 다른 사람에게 직접 메시지를 보내지 말고, 보고에 비밀값을 절대 넣지 마세요. 시작하기 전에 ${a.mode}(Lanes and workers, Reporting, Browser and testing 섹션), ${IDENTITY_FILE}(말투), 오너의 상시 규칙 ${paths.rules}(기본 동작보다 우선해요)를 읽고 따르세요. 계획과 리뷰는 직접 하고, 구현과 반복 작업은 task 워커로 돌리세요(워커 모델 ${a.workerModel}, modelRoles.task 경유). 워커의 diff는 적용하거나 머지하기 전에 직접 리뷰하세요. 서로 독립적인 조각을 한 워커 뒤에 줄 세우지 마세요: 이 머신은 task 워커를 최대 ${a.slots}개 동시에 돌리니, 독립적인 조각(다른 파일, 또는 하나씩 머지할 수 있는 분리된 섹션)은 한 번에 나눠 띄우고, 워커 하나는 순서대로 해야 하는 일에만 쓰세요. 시작할 때 작업을 한 번 분류하세요(무거움: 새 모듈, 보안·권한, 외부 연동, DB 스키마, 동시성, 도메인을 넘는 리팩터. 애매하면 무거움, 내리지 않기): 가벼움은 성공 기준 1-2개와 증거 1개, 무거움은 3개 이상(정상·경계·회귀)과 기준마다 증거, 리뷰어 통과까지. 테스트 통과만으로는 완료가 아니에요: 바뀐 동작을 실제 표면(명령, 화면, API)에서 돌려 증명하세요. 되돌릴 수 있고 요청 범위와 예산 안이면 추천안을 직접 골라 진행하고 보고에 적으세요. 오너에게는 확인 게이트(비밀, 결제, 외부 영향, 파괴적 작업)나 취향만 물으세요. 도구 호출 intent는 한국어 2-6단어로 쓰고, 워커 brief에도 같은 지시를 넣으세요.${a.worktree}`,
	worktree: w => `\n\n당신은 자신만의 git worktree ${w.path}(브랜치 ${w.branch})에서 일해요. ${w.repo}(${w.base})에서 갈라져 나온 거예요. 브리프에 나온 ${w.repo} 아래 경로는 ${w.path} 아래의 같은 파일을 뜻해요. 워커 brief에는 저장소 파일을 worktree 기준 상대 경로로 쓰세요: isolated 워커는 자기 사본에서 일하는데, ${w.repo}나 ${w.path} 절대 경로를 주면 실제 checkout을 고쳐요. 다른 레인과 오너는 ${w.repo}에서 일하니, 거기 파일은 절대 수정하지 마세요. 작업은 진행하면서 ${w.branch}에 커밋하세요. 추적되지 않는 설정(node_modules, .env, 빌드 결과물)은 worktree에 없으니 필요한 것은 설치하거나 링크하세요. Done-when 확인이 통과하면 이 프로젝트가 작업을 반영하는 방식대로 반영하세요(PR을 쓰는 프로젝트면 PR). 아니면 ${w.base} 위로 rebase(\`git rebase ${w.base}\`)한 뒤 \`git -C ${w.repo} merge --ff-only ${w.branch}\`를 하세요. 충돌이 나면 worktree에서 해결하고 다시 시도하세요. 강제로 밀지 말고 ${w.repo}를 reset하지 마세요. 머지한 커밋을 보고하세요. 머지 후 레인을 닫으면 게이트웨이가 worktree를 지워요.`,
	noGit: `\n\n이 폴더는 git 저장소가 아니라서 격리(isolated) 워커가 뜨지 않아요. 워커는 격리 없이 띄우세요(읽기만 하는 일은 격리가 필요 없어요). 파일을 고치는 워커라면 다른 워커와 겹치지 않는 파일만 맡기세요.`,

	replay: `${koLeads.replayLead}. 지금 처리하세요. 이미 일부는 끝났을 수 있으니 같은 동작을 반복하기 전에 확인하세요.`,
	newMessage: (target, replyTo, text) => `${koLeads.newMessageLead}. 이 메시지에는 별도 턴이 없어요. 지금 dotz_send target "${target}"${replyTo ? ` reply_to "${replyTo}"` : ""}로 답하세요(금방 끝나면 전체 답을, 아니면 언제쯤 답할지 짧게). 그다음 하던 일을 이어가세요. 최종 답은 처음 시작한 요청으로 가요.\n\n${text}`,
	waited: (seconds, target) => `${koLeads.waitedLead}: ${target}에 ${seconds}초째 아무것도 올라오지 않았어요. 지금 ${target}에 짧은 진행 메모를 올리고(dotz_send update_key "progress": 하는 일, 답이 나올 시점) 하던 일을 이어가세요.`,
	firstStart: target => `[dotz gateway] 이 설치의 첫 시작이에요. ${target}에서 먼저 말을 거세요: 짧은 메시지 몇 개로 오너에게 인사하세요(이름은 ${NAME}; 당신이 누구인지, 할 수 있는 일: 프로젝트별 채널, 모니터링, 레인, 스케줄). 그다음 오너의 환경을 읽기 전용으로 파악해도 되는지 한 번만 물어보세요: Aside에 있는 오너에 대한 메모리(aside memory list / search: 누구인지, 사람들, 프로젝트, 사이트), 로그인해 둔 사이트, 코딩 에이전트 세션과 프로젝트, 쓰는 도구와 CLI, 이 머신의 로그와 스케줄. 승낙하면 읽기 전용 워커로 진행하고, 진행 메시지 하나를 제자리에서 갱신하고(dotz_send update_key "onboarding"), 알게 된 것은 그때그때 메모리에 기록하고, 알아낸 것과 아직 모르는 것을 짧게 요약하며 끝내세요. 거절하면 시작하는 방법만 알려 주세요.`,

	inboxLaneReport: lane => `[dotz inbox] 레인 ${lane}의 보고:`,
	inboxWatchNoChannel: (watch, reason) => `[dotz inbox] watch ${watch} ${reason} (이 턴을 기다리는 사람이 없어요. 중요할 때만 dotz_send로 오너에게 알리세요):`,
	inboxWatch: (watch, reason, ch) => `[dotz inbox] watch ${watch} ${reason}, 작업 채널 ch:${ch} (최종 답이 그 채널로 가요. 아무것도 올리지 않으려면 "-" 한 글자만 답하세요):`,
	inboxMail: ch => `[dotz inbox] 작업 채널 ch:${ch}에 새 메일 (최종 답이 그 채널로 가요. 메일마다 스레드를 하나씩 "<sender> - <subject>" 제목으로 dotz_channel thread로 열어 거기에 요약을 올리세요. 상대가 오너에게 뭔가 원하면 추천 답장과 함께 알리세요. 읽기와 처리는 zele로 하고, 보내기는 오너가 OK한 뒤에만 하세요. 아무것도 올리지 않으려면 "-" 한 글자만 답하세요):`,
	inboxSchedule: (id, every, channel) => `[dotz inbox] 예약 항목 (${id}${every ? `, ${every}분마다` : ""}) - 지금 처리하세요. 최종 답은 ${channel}로 가요:`,
	inboxThread: (thread, parent) => ` (#${parent}의 스레드 "${thread}". 답은 스레드로 가요)`,
	inboxFirst: channel => `(새 작업 채널 #${channel}: 오너는 채널 단위로 일을 맡겨요. 이 채널의 작업과 보고는 여기에 두세요. 이 채널의 일에 로그인 유지나 시간이 지나며 확인할 것이 필요하면 직접 dotz_channel setup으로 이 채널에 설정하세요.)`,
	inboxBurst: n => `(sent as ${n} messages in a row; 하나의 요청으로 함께 읽으세요)`,
	replyingTo: (author, content) => `(${author}의 메시지에 대한 답장: "${content}")`,
	workChannels: list => `(작업 채널: ${list.length ? list.join("; ") : "아직 없음"})`,

	reflect: (digest, lessons) => `[dotz reflect] 지난 24시간의 야간 자기 점검이에요. 게이트웨이가 모은 데이터:\n${digest}\n
짧게 이렇게 하세요:
1. 잘못됐거나 비용이 너무 든 것을 찾으세요: 오너의 정정이나 반복된 요청, 실패했거나 멈춘 레인, 알림, 캐시 재작성.
2. 진짜 교훈마다 ${lessons}에 날짜가 붙은 줄을 하나 추가하거나 고치세요(30줄 안팎으로 유지하고, 더 이상 맞지 않거나 규칙이 이미 다루는 교훈은 지우세요). 오너에 대한 오래 갈 사실은 메모리 도구로 남기세요.
3. RULES.md나 LESSONS.md가 이미 다루는데도 되풀이된 일은 글을 더 쓴다고 나아지지 않아요. 오너에게 (dotz_send alert로) 전달 경로를 고치는 구체적인 방법(어느 파일, 훅, 브리프 footer, 확인을 바꿀지)을 보내세요.
4. 여기서 RULES.md는 절대 수정하지 마세요. 규칙 변경은 alert로 오너에게 제안하고 답을 기다리세요.
5. 마지막으로 dotz_send worklog 글 하나를 한국어로, identity의 Notices 문체로 올리세요: 첫 줄은 "야간 정리", 이어서 한 일을 쉬운 말로 "- " 글머리 항목으로(예: "- 배운 점 1개 LESSONS.md에 정리했어요", "- 고칠 거 제안 1건은 알림에 올렸어요"), 최대 4개, 영어로 된 개수 표기는 쓰지 마세요. 그 밖에는 아무것도 보내지 않아요.`,
};

const CATALOGS: Record<string, Catalog> = { en, ko };

// Everything detection needs is read at call time; the result is cached per identity text + IDENTITY.md mtime.
let detected: { key: string; code: string } | undefined;
function detectedLanguage(): string {
	const id = (cfg.identity ?? {}) as Record<string, unknown>;
	const text = Object.entries(id).filter(([k, v]) => !["name", "avatar", "language"].includes(k) && typeof v === "string").map(([, v]) => v as string).join("\n");
	const stamp = existsSync(IDENTITY_FILE) ? statSync(IDENTITY_FILE).mtimeMs : 0;
	const key = `${text}|${stamp}`;
	if (detected?.key === key) return detected.code;
	// IDENTITY.md has boilerplate in several languages; it only decides when config.json holds no identity text.
	const code = detectLanguage(text.trim() || !stamp ? text : readFileSync(IDENTITY_FILE, "utf8"));
	detected = { key, code };
	return code;
}

// The identity's language code: identity.language when set, else detected (see hub/language.ts).
export const lang = (): string => cfg.identity?.language?.trim() || detectedLanguage();

// Catalog in the identity's language; English for a language without originals.
export const msg = (): Catalog => CATALOGS[baseLanguage(lang())] ?? en;

// The reply-language line for a prompt that carries instructions; empty when the instructions are already in that language.
export function replyLine(): string {
	const code = lang();
	return baseLanguage(code) in CATALOGS ? "" : `Reply to the owner in ${languageName(code)} (${code}).`;
}
export const withReplyLine = (text: string): string => {
	const line = replyLine();
	return line ? `${text}\n\n${line}` : text;
};

// Does `text` start with the lead `key` names, in any language?
export const isNote = (text: string, key: keyof Leads): boolean =>
	Object.values(CATALOGS).some(c => text.startsWith(c[key]));

// The MODE contract in the identity's language: $DOTZ_DIR/MODE.<l>.md, repo MODE.<l>.md, then the English chain.
export function modeFile(): string {
	const repo = join(import.meta.dir, "..");
	const base = baseLanguage(lang());
	const chain = [...(base === "en" ? [] : [join(DATA_DIR, `MODE.${base}.md`), join(repo, `MODE.${base}.md`)]), join(DATA_DIR, "MODE.md"), join(repo, "MODE.md")];
	return chain.find(existsSync) ?? chain[chain.length - 1];
}
