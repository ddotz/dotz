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
export type SettingText = { label: string; hint?: string; unit?: string; options?: Record<string, string> };
export type FileText = { label: string; note: string };

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

// One sentence reused by every handover and, once after a compaction, by the next prompt: a fresh or compacted session
// loses what the old context held, so facts worth keeping are saved to memory before the work goes on.
const enRetainNudge = "Before continuing, save any durable owner, project or preference fact from the conversation so far that is not in memory yet with the omp memory `retain` tool; skip this if there is none.";
const koRetainNudge = "이어가기 전에, 지금까지의 대화에서 나온 오너·프로젝트·선호 중 오래 남길 사실이 아직 메모리에 없으면 omp memory `retain` 도구로 저장하세요. 없으면 건너뛰세요.";

const en = {
	...enLeads,

	recall: (a: RecallArgs) => `[dotz gateway] You are ${NAME}, the dotz orchestrator hosted headless by the gateway.\n\nIdentity (who you are and how you talk):\n${a.identity}\n\nContract:\n\n${a.mode}\n\nOwner rules (${paths.rules}; they override the contract):\n${a.rules}\n\nLessons (${paths.lessons}):\n${a.lessons}\n\nWork channel setups (dotz_channel list for login health):\n${a.setups}\n\nCurrent state.json:\n${a.state}`,
	identityFallback: (character: string, tone: string) => `Name: ${NAME}\nCharacter: ${character}\nTone: ${tone}\nSpeak in this character and tone in every reply.`,
	handover: (previous: string, tail: string) => `\n\n[handover] The previous session (${previous}) was rotated to keep the context small. Its most recent exchanges, oldest first; continue any open thread from here:\n${tail}\n\n${enRetainNudge}`,
	laneHandover: (previous: string, tail: string | undefined) => `[handover] The previous session (${previous}) was rotated.${tail ? ` Its most recent exchanges, oldest first:\n${tail}\n\n${enRetainNudge}` : ""}`,
	retainNudge: enRetainNudge,
	keepalive: "[keepalive] Cache keepalive from the gateway. Reply only: ok. No tools, no sends, no state edits.",

	orchRate: (held: number) => `${enLeads.rateLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchProvider: (held: number) => `${enLeads.providerLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchTransient: `${enLeads.transientLead}. Continue the request you were handling when it stopped.`,

	laneStopped: "[dotz gateway] Your process was restarted after it stopped responding. Continue the last request.",
	laneRate: `${enLeads.rateLead}. Continue the work you were doing when it stopped.`,
	laneProvider: `${enLeads.providerLead}. Continue the work you were doing when it stopped.`,
	laneTransient: `${enLeads.transientLead}. Continue the work you were doing when it stopped.`,
	// The one worklog / lane line when a fallback chain moves a process (or one of its task workers) to its next model.
	modelFallback: (from: string, to: string, reason?: string, worker?: boolean) => `${worker ? "Task worker model fallback" : "Model fallback"}: ${from} → ${to}${reason ? ` (${reason.replace(/\s+/g, " ").trim().slice(0, 120)})` : ""}`,
	// Hub-driven chain (conditional entries): a switch, a return to an earlier entry, and every entry spent.
	fallbackMove: (from: string, to: string, why: "quota" | "error" | "cap" | "revert") => `${why === "revert" ? "Model back" : "Model fallback"}: ${from} → ${to} (${{ quota: "usage limit reached", error: "provider error", cap: "spend cap reached", revert: "limit reset" }[why]})`,
	fallbackExhausted: (model: string, until: string) => `Model fallback: ${model} reached its spend cap and no fallback model is left. Paused until ${until}.`,
	laneOwnerResumed: "[dotz gateway] The owner resumed you. Continue the work you were doing.",
	laneOwnerRestarted: "[dotz gateway] Your process was restarted by the owner (settings changed). Continue the work you were doing.",
	laneMemory: (used: string, limit: string) => `[dotz gateway] Your process used ${used} GB of memory (limit ${limit} GB), so the gateway restarted it on the same session; any task workers you had running stopped too. omp's grep, cat and find run inside your own process: do not point them at huge trees (~, ~/Library, /) or multi-GB files, and quote paths with spaces. Check what your workers finished, relaunch the rest, and continue the work you were doing.`,
	laneGatewayRestarted: "[dotz gateway] The gateway restarted while you were working, which also stopped any task workers you had running. Check what they finished (patches, files, commits), relaunch the rest, and continue; if an owner message was cut off mid-turn, handle it too.",
	laneRotated: (why: string, cwd: string, brief: string, lastReport: string) => `[dotz gateway] Your session was rotated to a fresh one (${why}) to keep the context small. You keep your folder (${cwd}), model and goal. Read your brief (${brief}) and your last report (${lastReport}), check the current state of the work (git status, the files the brief names), and continue from there. Do not start new work and do not report: if nothing is open, reply with the single word "ready".`,
	heldMessages: (text: string, held: string[]) => `${text}\n\n${held.length} owner message(s) arrived while you were paused; handle each, oldest first:\n\n${held.join("\n\n---\n\n")}`,

	footer: (a: LaneFooterArgs) => `\n\n---\n[dotz lane ${a.lane}] You are a lane of ${NAME}: a full omp orchestrator for this folder with one goal. The final message of each turn is your report: ${NAME} relays it and the owner reads it in the lane channel. Keep it to ~800 characters in the report shape of ${a.mode} (Reporting): the first line is the outcome, led by a tone marker [done]/[run]/[ask]/[fail]; then, only when the owner must answer something, a **Decision needed** paragraph of numbered questions, each with its options and your recommendation; then at most 3-4 bullets of what changed and how you checked it (paths, the Done-when check you ran yourself, the merged commit); last, one "For ${NAME}:" line for what the orchestrator handles, never mixed with the owner's questions. The owner may write to you directly. Do not message Discord or other people yourself, and never put secrets in a report. Before you start, read and follow ${a.mode} (sections Lanes and workers, Reporting, Browser and testing), ${IDENTITY_FILE} (voice) and the owner's standing rules in ${paths.rules} (they override your defaults). Plan and review yourself; run implementation and grind work as task workers (worker model ${a.workerModel} via modelRoles.task), and review a worker's diff yourself before applying or merging it. Do not queue independent slices behind one worker: this machine runs up to ${a.slots} task workers at once, so fan independent slices (different files, or separable sections merged one by one) out in one batch; keep one worker only for work that must be sequential. Size the work once at the start (heavy: new module, security or permissions, external integration, DB schema, concurrency, cross-domain refactor; unsure is heavy; never downgrade): light = 1-2 success criteria and one proof, heavy = 3+ (happy, edge, regression) with a proof each and a reviewer pass. Passing tests is not done: prove the changed behavior on its real surface (command, screen, API). Take reversible choices inside the request and budget yourself and note them in the report; ask the owner only at the confirmation gates (secrets, payments, external blast radius, destructive steps) or for taste. Write tool-call intents in the owner's language, 2-6 words, and tell your workers the same.${a.worktree}`,
	worktree: (w: WorktreeArgs) => `\n\nYou work in your own git worktree ${w.path} on branch ${w.branch}, split from ${w.repo} (${w.base}); paths under ${w.repo} in your brief mean the same files under ${w.path}. In worker briefs write repo files as paths relative to the worktree: an isolated worker gets its own copy, and an absolute ${w.repo} or ${w.path} path makes it edit the real checkout. Other lanes and the owner work in ${w.repo}: never edit files there. Commit your work on ${w.branch} as you go. Untracked setup (node_modules, .env, build output) is not in the worktree: install or link what you need. When the Done-when check passes, land it the way this project lands work (a PR if it uses them); otherwise rebase onto ${w.base} (\`git rebase ${w.base}\`), then \`git -C ${w.repo} merge --ff-only ${w.branch}\`. On a conflict, resolve it in your worktree and retry; never force, never reset ${w.repo}. Report the merged commit. The gateway removes your worktree when the lane is closed after the merge.`,
	noGit: `\n\nThis folder is not a git repository, so isolated task workers cannot start here: run workers without isolation (read-only work needs none), and if a worker must edit files, keep its slice to files no other worker touches.`,

	replay: `${enLeads.replayLead}. Handle it now; it may be partly done already, so check before repeating an action.`,
	newMessage: (target: string, replyTo: string | undefined, text: string) => `${enLeads.newMessageLead}; it gets no turn of its own. Answer it now with dotz_send target "${target}"${replyTo ? ` reply_to "${replyTo}"` : ""} (the full answer if it is quick, else a short note on when), then continue the current work. Your final answer still goes to the request you started with.\n\n${text}`,
	waited: (seconds: number, target: string) => `${enLeads.waitedLead} ${seconds}s in ${target} with nothing posted there. Post a short progress note in ${target} now (dotz_send update_key "progress": what you are doing, when the answer comes), then carry on.`,
	firstStart: (target: string) => `[dotz gateway] First start of this install. Speak first in ${target}: greet the owner in a few short messages as ${NAME} (who you are, what you can do: channels per project, monitoring, lanes, schedules). Then ask once whether you may learn their setup, read-only: Aside's memory of them (aside memory list / search: who they are, people, projects, sites) and the sites they are signed in to, coding agent sessions and their projects, tools and CLIs in use, logs and schedules on this machine. On yes, do it with read-only workers, keep one progress message updated in place (dotz_send update_key "onboarding"), record what you learn in memory as you go, and end with a short summary of what you learned and what is still missing. On no, just say how to start.`,

	inboxLaneReport: (lane: string) => `[dotz inbox] lane report from ${lane}:`,
	inboxWatchNoChannel: (watch: string, reason: string) => `[dotz inbox] watch ${watch} ${reason} (no one is waiting for this turn; tell the owner with dotz_send only if it matters):`,
	inboxWatch: (watch: string, reason: string, ch: string) => `[dotz inbox] watch ${watch} ${reason} for work channel ch:${ch} (your final answer goes there; reply "-" alone to post nothing):`,
	inboxMail: (ch: string) => `[dotz inbox] new mail for work channel ch:${ch} (your final answer goes there; open one thread per mail with dotz_channel thread, kind = the sender, name = the subject, and put the summary there; if a person wants something from the owner, brief them with a suggested reply; read or act with zele, sending only after the owner's OK; reply "-" alone to post nothing):`,
	inboxSchedule: (id: string, every: number | undefined, channel: string) => `[dotz inbox] scheduled (${id}${every ? `, every ${every} min` : ""}) - do it now; your final answer goes to ${channel}:`,
	inboxThread: (thread: string, parent: string) => ` (thread "${thread}" in #${parent}; your answer goes into the thread)`,
	inboxFirst: (channel: string) => `(new work channel #${channel}: the owner hands out work by channel. Keep this channel's work and reports here. If its work needs a login kept alive or something checked over time, set that up for this channel with dotz_channel setup yourself.)`,
	inboxBurst: (n: number) => `(sent as ${n} messages in a row; read them together as one request)`,
	replyingTo: (author: string, content: string) => `(replying to ${author}: "${content}")`,
	workChannels: (list: string[]) => `(work channels: ${list.length ? list.join("; ") : "none yet"})`,
	replyIn: (language: string, drifted: boolean) => drifted ? `(Your last text for the owner was not in ${language}. Write everything for the owner in ${language} only.)` : `(Answer the owner in ${language}.)`,

	reflect: (digest: string, lessons: string) => `[dotz reflect] Nightly self-review of the last 24h. Data from the gateway:\n${digest}\n
Do this, briefly:
1. Find what went wrong or cost too much: owner corrections or repeated asks, failed or stuck lanes, alerts, cache rewrites.
2. For each real lesson add or update one dated line in ${lessons} (keep it under ~30 lines; delete lessons that no longer apply or that a rule already covers). Retain durable facts about the owner with your memory tool.
3. If something recurred although RULES.md or LESSONS.md already covers it, more text will not help: send the owner (dotz_send alert) a concrete fix for the carrier (which file, hook, brief footer or check to change).
4. Never edit RULES.md here; propose rule changes to the owner in alert and wait for their answer.
5. Finish with one dotz_send worklog post in the identity's language and Notices style: a first line "Nightly review", then "- " bullets in plain words for what you did (e.g. "- 1 lesson noted in LESSONS.md", "- 1 proposed fix posted to alert"), at most 4 bullets. Nothing else is sent.`,

	// Appended to `reflect` only when LESSONS.md has stale or near-duplicate lines or is over its byte cap (hub/reflect.ts lessonCandidates).
	lessonCandidates: (stale: string[], duplicates: string[], over: string) => `\n\nLESSONS.md cleanup candidates picked by code; you decide which to delete or merge (keep the newer or more specific wording):${over ? `\n- ${over}` : ""}${stale.length ? `\n- Older than 90 days:\n${stale.join("\n")}` : ""}${duplicates.length ? `\n- Near-duplicates (token overlap >= 0.6):\n${duplicates.join("\n")}` : ""}`,

	// Owner-facing strings of the Discord login-auth prompts (hub/auth.ts).
	auth: {
		titles: { secret: "Login details needed", otp: "Verification code needed", approve: "Login approval needed" },
		site: "Site",
		expires: (time: string) => `Until ${time} KST`,
		input: "Enter",
		approve: "I approved",
		cancel: "Cancel",
		labels: { username: "Username", password: "Password", code: "Verification code" },
		modalTitle: (site: string) => `${site} login`,
		statuses: { entered: "Received.", approved: "Approved.", cancelled: "Cancelled.", timeout: "Expired without an answer." },
		notOwner: "Only the owner can answer this.",
		finished: "This request is already finished or expired.",
		received: "Received. The value goes only to the gateway.",
		incomplete: "Some fields were empty. Press the button again.",
		storeFailed: "Could not save it. Press the button again.",
	},

	// Owner-facing strings of the 구성 map (hub/harness.ts); `locale` formats its dates and numbers.
	harness: {
		locale: "en-US",
		common: { state: "State", disabled: "Turned off", off: "Off", set: "Set", none: "None", count: (n: number) => `${n}`, daily: (time: string) => `daily ${time}` },
		status: { working: "Working", idle: "Idle", starting: "Starting", stopped: "Stopped", "rate-limited": "Rate-limited", exited: "Exited" } as Record<string, string>,
		ago: { now: "<1 min", min: (m: number) => `${m} min`, hourMin: (h: number, m: number) => `${h} h ${m} min`, day: (d: number) => `${d} d`, before: (d: string) => `${d} ago` },
		fileFact: { label: "File", missing: "Not there yet", size: "Size", chars: (n: string) => `${n} chars`, modified: "Last modified" },
		files: {
			"MODE.md": { label: "Behaviour rules (MODE)", note: "Ships with the repository, so it is read-only here." },
			"RULES.md": { label: "My rules", note: "Blocked commands apply at once; the rest is picked up the next time it is read, after a new session or compaction." },
			"LESSONS.md": { label: "Lessons", note: "Picked up the next time it is read, after a new session or compaction." },
			"identity/IDENTITY.md": { label: "Identity", note: "Picked up the next time it is read, after a new session or compaction." },
		} as Record<string, FileText>,
		notOpenable: (name: string) => `"${name}" is not a file you can open (MODE.md, RULES.md, LESSONS.md, identity/IDENTITY.md)`,
		settings: {
			"orchestrator.model": { label: "Model" },
			"orchestrator.thinking": { label: "Thinking effort" },
			"orchestrator.rotate_tokens": { label: "Switch-to-new-session threshold", unit: "tokens", hint: "When the conversation gets this long, it moves to a new session with a handover while idle" },
			"lanes.model": { label: "Default model for new lanes" },
			"lanes.thinking": { label: "Thinking effort for new lanes" },
			"lanes.max_active": { label: "Lanes working at once", unit: "lanes" },
			"lanes.compact_at": { label: "Auto-compaction starts at", unit: "tokens", hint: "When a lane's context fills this far, it is summarized and shrunk" },
			"lanes.keep_recent": { label: "Recent conversation kept when compacting", unit: "tokens" },
			"lanes.worker_model": { label: "Worker model" },
			"lanes.worker_effort": { label: "Worker thinking effort" },
			"lanes.nightly_at": { label: "Nightly cleanup time", hint: "HH:MM or off" },
			"lanes.nightly_compact_at": { label: "Nightly compaction threshold", unit: "tokens" },
			"lanes.rotate_mb": { label: "Session file rotation size", unit: "MB" },
			"lanes.max_rss_gb": { label: "Process memory limit", unit: "GB", hint: "Above this, the process restarts on the same session. To turn it off, set 0 in config.json" },
			"gateway.coalesce_ms": { label: "Time to merge consecutive messages", unit: "ms", hint: "Messages arriving in the same channel within this time are handled together" },
			"reflect_at": { label: "Nightly review time", hint: "HH:MM or off" },
			"token_audit_at": { label: "Token audit time", hint: "HH:MM or off" },
			"omp_update.mode": { label: "Update mode", options: { check: "Notify of new versions only", install: "Install automatically and restart", off: "Off" } },
			"omp_update.at": { label: "Update check time", hint: "HH:MM or off" },
			"backup.remote": { label: "Backup repository address", hint: "If empty, snapshots stay on this computer only. Files containing secrets are never uploaded" },
			"output_language.mode": { label: "Output language check", options: { rewrite: "Rewrite if in another language", off: "Off" } },
			"output_language.model": { label: "Model for rewriting", hint: "If empty, omp's default small model" },
			"output_language.timeout_s": { label: "Rewrite time limit", unit: "s" },
			"zele.enabled": { label: "Mail and calendar check" },
			"zele.poll_sec": { label: "Check interval", unit: "s" },
			"zele.brief_hour": { label: "Morning briefing hour", unit: "h" },
			"identity.name": { label: "Name" },
			"identity.language": { label: "Reply language", hint: "ko, en, ja … If empty, detected from the identity text" },
			"identity.character": { label: "Character", hint: "If the identity file (IDENTITY.md) exists, it takes precedence" },
			"identity.tone": { label: "Tone", hint: "Also the tone reference for output-language rewriting" },
		} as Record<string, SettingText>,
		nodes: {
			discord: {
				summary: { connected: (n: number) => `Connected · work channels: ${n}`, disconnected: "Disconnected" },
				desc: "Receives what is written in chat rooms, work channels and lane threads, passes it to the gateway, and posts the reply in the same place. Received messages are marked with 👀 first. Connection details (token, server, owner) cannot be changed from this screen for security.",
				state: { off: "Off (token, server or owner is missing)", connected: "Connected", disconnected: (err: string) => `Disconnected${err ? ` · ${err}` : ""}` },
				workChannels: "Work channels", laneThreads: "Lane threads", token: "Bot token", owner: "Owner", guild: "Server",
			},
			web: {
				label: "Web app", summary: "This screen · reachable only inside the tailnet",
				desc: "The screen you are looking at. See chats, lanes and settings; a message you send goes through the gateway to the orchestrator. The server listens only on this computer (127.0.0.1); from outside, Tailscale attaches the login identity and lets you in.",
				access: "Access", accessValue: "Only logins allowed through Tailscale", sending: "Sending messages", sendingValue: "Normal / Insert / Interrupt and send",
				port: "Port", tailscalePort: "Tailscale HTTPS port", logins: "Allowed logins", loginCount: (n: number) => `${n}`,
			},
			terminal: {
				label: "Terminal", summary: (n: number) => `Connected terminals: ${n}`, none: "No terminals connected",
				desc: (_name: string) => `Run /dotz on in a terminal and that terminal becomes an input box: what you type goes to the gateway orchestrator. Run /dotz off and it is a normal terminal again.`,
				connected: "Connected terminals",
			},
			schedule: {
				label: "Schedules", summary: (n: number, next: string) => `${n} scheduled${next}`, none: "No schedules", next: (d: string, future: boolean) => ` · next ${future ? `in ${d}` : `was ${d} ago`}`,
				desc: "Sends a prepared sentence to the orchestrator at a set time (once, or repeating at intervals of 5 minutes or more). The orchestrator can create and delete schedules.",
				schedules: "Schedules", nextRun: "Next run", repeating: "Repeating schedules",
			},
			watch: {
				label: "Watches", summary: (n: number, failing: number) => `Watches: ${n}${failing ? ` · failing in a row: ${failing}` : ""}`, none: "No watches",
				desc: "Runs a command at a set interval without waking the model, and tells you only when the value changed, a condition matched, or it failed. Keeping logins alive (session checks) is done here too. After 2 failures in a row it notifies once per 12 hours, and once more when it recovers.",
				watches: "Watches", setups: "Per-work-channel setups", failing: "Failing in a row",
			},
			mail: {
				label: "Mail and calendar", summary: (sec: number, hour: number) => `Checks every ${sec} s · morning briefing at ${hour}:00`,
				desc: "Checks Google mail and calendar with zele: new mail goes to a thread in the mail channel, upcoming events become notifications, and a daily briefing arrives in the morning. Promotional and notification mail is filtered out.",
				on: "On (rechecks every 10 minutes if there is no account)",
			},
			gateway: {
				label: "Gateway", summary: "Merge messages · handle commands · deliver replies",
				desc: "The door every input goes through. Consecutive messages in the same channel are merged into one; commands like /model and /restart and the \"limits\" question are answered directly without waking the orchestrator. Replies go back to the channel that asked, and if no reply goes out within 60 seconds, a progress report is requested. Messages left unanswered at a restart are handled again.",
				merge: "Merge window", mergeValue: (ms: number) => `${ms}ms (up to 20 s)`, direct: "Answered directly", directValue: `/commands, "limits"`,
				route: "Reply route", routeValue: "The channel the question came from (Discord, web, terminal)", restart: "Restart", restartValue: "After all work is done (up to 20 min), restarts with the new code",
			},
			orchestrator: {
				label: (name: string) => `Orchestrator (${name})`,
				desc: "The always-on assistant that receives every message (one omp session). It does light work itself and hands long work to lanes. When a usage limit hits, it holds messages and handles them in order right after the reset; server errors are retried up to 4 times. If it dies it is restarted automatically (up to 3 times in 10 minutes), and when the conversation grows long it moves to a new session with a handover. Changing the model starts a new session.",
				context: "Context", resumes: "Resumes at", cache: "Cache keep-alive", cacheValue: "One ping at 50-58 minutes while idle (up to 12)",
				startPrompt: "Start prompt", startPromptValue: "Behaviour rules + identity + my rules + lessons + work-channel summary",
			},
			mode: {
				label: "Behaviour rules (MODE)", summary: (file: string) => `${file} · read-only`,
				desc: "The base contract that decides how the orchestrator and lanes work. It ships with the repository, so it is read-only here.",
				file: "File in use", language: "Language",
			},
			identity: {
				label: "Identity", summary: (name: string, language: string) => `Name ${name} · reply language ${language}`,
				desc: "Name, character and tone. If IDENTITY.md exists its content goes into the start prompt, otherwise the character and tone from settings do. The reply language is also the reference for the output-language check.",
			},
			rules: {
				label: "My rules (RULES)", summary: (n: number) => `Rules file · blocked commands: ${n}`,
				desc: "The standing rules and prohibitions I set. They take precedence over the behaviour rules and lanes read them too. Lines under \"Blocked commands\" are blocked before the orchestrator, lanes and workers run them.",
				blocked: "Blocked commands",
			},
			lessons: {
				label: "Lessons (LESSONS)", summary: "Notes built by the nightly review",
				desc: "Notes the orchestrator tidies itself in the nightly review (about 30 lines). My rules always win. You can edit or delete them.",
			},
			lanes: {
				label: "Lanes", summary: (n: number, working: number, max: number) => `${n} · ${working} working · up to ${max} at once`, none: (max: number) => `None · up to ${max} at once`,
				desc: "Independent sessions that take on long project work (one lane per channel). In a git repository each lane works in its own worktree and branch, so my working folder is untouched, and it is cleaned up once merged. Each start rewrites the settings file (omp overlay) to apply the worker model and auto-compaction threshold. A stopped lane is restarted automatically (up to 3 times an hour).",
				lanes: "Lanes", lanesValue: (n: number, working: number) => `${n} (${working} working)`, workDir: "Work folder", workDirValue: "In a git repository, a worktree just for the lane",
				compaction: "Compaction", compactionValue: (tokens: string) => `Automatic at ${tokens} tokens of context`,
			},
			workers: {
				label: "Workers (subagents)", running: (n: number) => ` · ${n} running`,
				desc: "Hands that lanes split implementation, testing and exploration across. A lane plans and reviews with its own model while workers run in parallel on a cheaper one. Workers that write files work in an isolated copy and return the result as a patch. A patch can be applied only after it has been read.",
				kinds: "Kinds", kindsValue: "task (implement, test, render), scout (explore)", limit: "Concurrency limit", limitValue: (n: number) => `${n} per lane (based on this computer's specs)`,
				runningFact: "Running", isolation: "Isolation", isolationValue: "Writing workers: isolated copy + patch applied after review",
				expensive: "Expensive model", expensiveValue: "Fable and top effort only when I ask for it myself",
			},
			outlang: {
				label: "Output language check", summary: (language: string) => `Rewritten and sent if not in ${language}`,
				desc: "If text going to me differs from the identity language (e.g. leaked while thinking in English), it is translated with one call to a small model. Language detection is local, so it is free, and if it fails the original goes out as is.",
				reference: "Reference language",
			},
			update: {
				label: "omp update check", install: "automatic install", check: "new versions only",
				desc: "Checks daily whether a new omp version exists and tells the work-log channel. With 'automatic install' it installs and restarts the gateway when everything is idle.",
			},
			audit: {
				label: "Token usage audit",
				desc: "Scans omp session records daily for waste, such as a cache that broke for no reason or a session with an abnormally large context. If something is off, it tells the alert channel.",
			},
			reflect: {
				label: "Nightly review", summary: (when: string) => `${when} · lessons tidy-up + backup`,
				desc: "Each night it summarizes the previous day's conversations for the orchestrator to look back on and has it write what it learned to the lessons file. Before that it leaves a git snapshot of the settings folder. Quiet days are skipped.",
			},
			backup: {
				label: "Backup", remote: "Snapshot + external repository", local: "Snapshot on this computer only",
				desc: "Snapshots settings, rules and lessons with git every night. If you enter a repository address it also uploads them, but nothing is uploaded if even one file looks like a secret.",
				external: "External repository", credentialed: "Set (contains credentials)", credentialedHint: "Contains credentials, so it cannot be changed from this screen",
			},
			providers: {
				label: "Providers and limits", summary: (n: number, low: number | undefined) => (low === undefined ? `${n} in use` : `${n} in use · lowest limit ${low}% left`),
				desc: "Login/keys and usage for model providers (Anthropic etc.). Before starting a lane it looks at the 5-hour limit and asks first if less than 10% would remain after this work's share (default 15%). The 7-day limit is shown only.",
				used: "Providers in use", remaining: (pct: number) => `${pct}% left`,
			},
			hygiene: {
				label: "Lane nightly cleanup", summary: (when: string) => `${when} · compact and rotate long lanes`,
				desc: "At a set time each day it checks idle lanes: if the session file is big it moves to a new session (handover), and if the context is big it compacts. Lanes that were working are left alone. It also deletes leftover temporary folders of finished workers every hour.",
			},
			memguard: {
				label: "Memory guard", summary: (gb: number) => `Restarts above ${gb} GB per process`,
				desc: "Every 30 seconds it checks the memory of the orchestrator and lane processes and restarts them on the same session when over the limit (it stops a stray grep from eating tens of GB). If that happens more than 3 times an hour it only sends an alert and stops.",
			},
			guard: {
				label: "Work guard (omp extension)", summary: "Checks briefs, patches, budget and external commands", missing: "Not installed",
				desc: "The orchestrator-guard extension installed on the omp side (outside the gateway, in this computer's omp settings). It enforces the rules below when a worker is called and while it runs. Read-only here.",
				installed: "Installed", notInstalled: "Not installed (the rules are not enforced)",
				briefing: "Briefing", briefingValue: "Done-when required · 8000-character and 40-line code limits · answers within 800 characters",
				patch: "Patches", patchValue: "Writing workers isolated + patch must be read before it can be applied",
				budget: "Budget", budgetValue: "Blocks and asks permission if the 5-hour limit is short",
				expensive: "Expensive model", expensiveValue: "Fable and top effort only when I ask",
				external: "External commands", externalValue: "Workers cannot push, deploy, ssh or send externally, and hand them back",
				context: "Context", contextValue: "Worker compaction 1st: nudge to wrap up, 2nd: block tools",
				blocked: "Blocked commands in my rules",
			},
		},
		edges: {
			discord: "Message", web: "Chat", terminal: "Terminal input", schedule: "Scheduled time", watch: "Change detected", mail: "New mail and events",
			batch: "Passed on merged", delegate: "Delegate work", parallel: "Parallel run", mode: "Behaviour rules", identity: "Name and tone", rules: "My rules", rulesLanes: "Lanes read it too",
			lessons: "Lessons", lessonsWrite: "Write lessons", snapshot: "Snapshot", review: "Review request", outlang: "Reply language check", update: "New version notice", audit: "Waste alert",
			providers: "Model and limits", budget: "Budget gate", hygiene: "Nightly cleanup", memguard: "Memory watch", guard: "Enforce rules",
		},
		// The per-project maps (hub/harnessprojects.ts): one lane tied to a work or home channel.
		project: {
			channelKind: { work: "Work channel", home: "Home channel", thread: "Lane thread" } as Record<string, string>,
			edgeIn: "Message", edgeFiles: "Read as instructions", edgeFeatures: "Applies here",
			globalNote: "This is a global setting. Change it on the main map; it is not set per project.",
			fallbackStep: (model: string, when?: string, cap?: string, revert?: string) => `${model}${when ? ` when ${when}` : ""}${cap ? ` · cap ${cap}` : ""}${revert ? ` · revert ${revert}` : ""}`,
			channel: {
				summary: (kind: string, purpose: string) => (purpose ? `${kind} · ${purpose}` : kind),
				desc: "A channel this project's lane answers in. Messages written here reach the lane's project with this channel's context.",
				kind: "Kind", purpose: "Purpose", logins: "Kept logins", monitors: "Monitors", standing: "Standing behaviour", updated: "Setup updated", noSetup: "No setup for this channel yet",
			},
			lane: {
				label: (name: string) => `Lane ${name}`,
				desc: "The lane that works on this project. Its model, effort and runtime can differ from the global lane defaults; the settings below show which ones do.",
				state: "State", cwd: "Folder", repo: "Repository", thread: "Thread", runtime: "Runtime", fallback: "Fallback chain", none: "None",
			},
			workers: {
				label: (name: string) => `Workers (${name})`,
				desc: "The task workers this lane starts. Their model and effort can differ from the global worker defaults.",
				fallback: "Fallback chain", model: "Model", effort: "Effort",
			},
			files: { desc: "A project instruction file found in the lane's folder. Only its name, size, modified time and first heading are shown.", size: "Size", modified: "Last modified", heading: "First heading", bytes: (n: string) => `${n} bytes`, folder: "Folder" },
			features: {
				label: "Project features", summary: (n: number) => `${n} item${n === 1 ? "" : "s"}`, none: "Nothing project-only found",
				desc: "Skills kept in the project folder and watches tied to this project's channels. They apply only here.",
				skill: "Skill", watch: "Watch", watchValue: (every: number, on: string) => `every ${every} min · on ${on}`,
			},
			deny: { label: "Project blocked commands", summary: (n: number) => `${n} line${n === 1 ? "" : "s"}`, desc: "'- deny:' lines under '## Blocked commands' in the project's instruction files. They are written for this project only." },
			settings: {
				model: { label: "Lane model", hint: "Applies at once; a running lane restarts on the new model" },
				effort: { label: "Lane effort" },
				workerModel: { label: "Worker model", hint: "Applies to workers this lane starts next" },
				workerEffort: { label: "Worker effort" },
				runtime: { label: "Runtime", hint: "Applies the next time the lane starts" },
			},
		},
	},
};
type Catalog = typeof en;

const ko: Catalog = {
	...koLeads,

	recall: a => `[dotz gateway] 당신은 게이트웨이가 헤드리스로 띄운 dotz 오케스트레이터(${NAME})예요.\n\n정체성 (당신이 누구이고 어떻게 말하는지):\n${a.identity}\n\n계약:\n\n${a.mode}\n\n오너 규칙 (${paths.rules}; 계약보다 우선해요):\n${a.rules}\n\n교훈 (${paths.lessons}):\n${a.lessons}\n\n작업 채널 설정 (로그인 상태는 dotz_channel list):\n${a.setups}\n\n현재 state.json:\n${a.state}`,
	identityFallback: (character, tone) => `이름: ${NAME}\n성격: ${character}\n말투: ${tone}\n모든 답을 이 성격과 말투로 하세요.`,
	handover: (previous, tail) => `\n\n[handover] 이전 세션(${previous})은 컨텍스트를 작게 유지하려고 교체했어요. 가장 최근 대화를 오래된 순으로 붙여요. 열려 있는 일이 있으면 여기서 이어가세요:\n${tail}\n\n${koRetainNudge}`,
	laneHandover: (previous, tail) => `[handover] 이전 세션(${previous})을 교체했어요.${tail ? ` 가장 최근 대화를 오래된 순으로 붙여요:\n${tail}\n\n${koRetainNudge}` : ""}`,
	retainNudge: koRetainNudge,
	keepalive: "[keepalive] 게이트웨이의 캐시 유지 신호예요. ok 한 단어로만 답하세요. 도구, 전송, 상태 수정은 하지 마세요.",

	orchRate: held => `${koLeads.rateLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.${held ? ` 멈춰 있는 동안 도착한 메시지 ${held}건이 오래된 순으로 이어서 와요.` : ""}`,
	orchProvider: held => `${koLeads.providerLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.${held ? ` 멈춰 있는 동안 도착한 메시지 ${held}건이 오래된 순으로 이어서 와요.` : ""}`,
	orchTransient: `${koLeads.transientLead}. 멈췄을 때 처리하던 요청을 이어서 하세요.`,

	laneStopped: "[dotz gateway] 프로세스가 응답을 멈춰서 다시 시작했어요. 마지막 요청을 이어서 처리하세요.",
	laneRate: `${koLeads.rateLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	laneProvider: `${koLeads.providerLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	laneTransient: `${koLeads.transientLead}. 멈췄을 때 하던 작업을 이어서 하세요.`,
	modelFallback: (from: string, to: string, reason?: string, worker?: boolean) => `${worker ? "작업자 모델 폴백" : "모델 폴백"}: ${from} → ${to}${reason ? ` (${reason.replace(/\s+/g, " ").trim().slice(0, 120)})` : ""}`,
	fallbackMove: (from: string, to: string, why: "quota" | "error" | "cap" | "revert") => `${why === "revert" ? "모델 복귀" : "모델 폴백"}: ${from} → ${to} (${{ quota: "사용 한도 도달", error: "제공자 오류", cap: "사용 상한 도달", revert: "한도가 풀렸어요" }[why]})`,
	fallbackExhausted: (model: string, until: string) => `모델 폴백: ${model}이(가) 사용 상한에 도달했고 넘어갈 모델이 더는 없어요. ${until}까지 멈춰요.`,
	laneOwnerResumed: "[dotz gateway] 오너가 당신을 다시 시작시켰어요. 하던 작업을 이어서 하세요.",
	laneOwnerRestarted: "[dotz gateway] 오너가 설정을 바꿔서 프로세스를 다시 시작했어요. 하던 작업을 이어서 하세요.",
	laneMemory: (used, limit) => `[dotz gateway] 프로세스가 메모리를 ${used}GB 써서(한도 ${limit}GB) 게이트웨이가 같은 세션으로 다시 시작했어요. 실행 중이던 task 워커도 모두 멈췄어요. omp의 grep, cat, find는 당신 프로세스 안에서 돌아요. 아주 큰 폴더(~, ~/Library, /)나 수 GB짜리 파일에 쓰지 말고, 공백이 있는 경로는 따옴표로 감싸세요. 워커가 끝낸 것을 확인하고 나머지는 다시 띄운 뒤 하던 작업을 이어가세요.`,
	laneGatewayRestarted: "[dotz gateway] 작업 중에 게이트웨이가 다시 시작돼서 실행 중이던 task 워커도 모두 멈췄어요. 워커가 끝낸 것(패치, 파일, 커밋)을 확인하고, 나머지는 다시 띄워서 이어가세요. 오너 메시지가 턴 도중에 끊겼다면 그것도 처리하세요.",
	laneRotated: (why, cwd, brief, lastReport) => `[dotz gateway] 컨텍스트를 작게 유지하려고 세션을 새로 바꿨어요 (${why}). 폴더(${cwd}), 모델, 목표는 그대로예요. 브리프(${brief})와 마지막 보고(${lastReport})를 읽고, 작업의 현재 상태(git status, 브리프가 가리키는 파일)를 확인한 뒤 거기서 이어가세요. 새 작업을 시작하거나 보고하지 마세요. 열려 있는 일이 없으면 "ready" 한 단어로만 답하세요.`,
	heldMessages: (text, held) => `${text}\n\n멈춰 있는 동안 오너 메시지 ${held.length}건이 도착했어요. 오래된 순으로 각각 처리하세요:\n\n${held.join("\n\n---\n\n")}`,

	footer: a => `\n\n---\n[dotz lane ${a.lane}] 당신은 ${NAME}의 레인이에요: 목표가 하나인 이 폴더 전용 omp 오케스트레이터예요. 각 턴의 마지막 메시지가 보고예요. 보고는 게이트웨이가 ${NAME}의 이름으로 전달하고, 오너는 레인 채널에서 읽어요. 보고는 800자 안팎으로, ${a.mode}(Reporting)의 보고 형식대로 쓰세요: 첫 줄은 결론(맨 앞에 상태 표식 [done]/[run]/[ask]/[fail]). 오너가 답해야 할 게 있을 때만 그다음 문단에 **결정 필요** 아래 번호 질문(질문마다 선택지와 추천). 이어서 바뀐 것과 확인한 것 최대 3-4줄(경로, 직접 돌린 Done-when 확인, 머지 커밋). 마지막에 ${NAME}가 처리할 것은 "${NAME} 몫:" 한 줄로 쓰고, 오너 질문과 섞지 마세요. 오너가 당신에게 직접 쓸 수도 있어요. Discord나 다른 사람에게 직접 메시지를 보내지 말고, 보고에 비밀값을 절대 넣지 마세요. 시작하기 전에 ${a.mode}(Lanes and workers, Reporting, Browser and testing 섹션), ${IDENTITY_FILE}(말투), 오너의 상시 규칙 ${paths.rules}(기본 동작보다 우선해요)를 읽고 따르세요. 계획과 리뷰는 직접 하고, 구현과 반복 작업은 task 워커로 돌리세요(워커 모델 ${a.workerModel}, modelRoles.task 경유). 워커의 diff는 적용하거나 머지하기 전에 직접 리뷰하세요. 서로 독립적인 조각을 한 워커 뒤에 줄 세우지 마세요: 이 머신은 task 워커를 최대 ${a.slots}개 동시에 돌리니, 독립적인 조각(다른 파일, 또는 하나씩 머지할 수 있는 분리된 섹션)은 한 번에 나눠 띄우고, 워커 하나는 순서대로 해야 하는 일에만 쓰세요. 시작할 때 작업을 한 번 분류하세요(무거움: 새 모듈, 보안·권한, 외부 연동, DB 스키마, 동시성, 도메인을 넘는 리팩터. 애매하면 무거움, 내리지 않기): 가벼움은 성공 기준 1-2개와 증거 1개, 무거움은 3개 이상(정상·경계·회귀)과 기준마다 증거, 리뷰어 통과까지. 테스트 통과만으로는 완료가 아니에요: 바뀐 동작을 실제 표면(명령, 화면, API)에서 돌려 증명하세요. 되돌릴 수 있고 요청 범위와 예산 안이면 추천안을 직접 골라 진행하고 보고에 적으세요. 오너에게는 확인 게이트(비밀, 결제, 외부 영향, 파괴적 작업)나 취향만 물으세요. 도구 호출 intent는 한국어 2-6단어로 쓰고, 워커 brief에도 같은 지시를 넣으세요.${a.worktree}`,
	worktree: w => `\n\n당신은 자신만의 git worktree ${w.path}(브랜치 ${w.branch})에서 일해요. ${w.repo}(${w.base})에서 갈라져 나온 거예요. 브리프에 나온 ${w.repo} 아래 경로는 ${w.path} 아래의 같은 파일을 뜻해요. 워커 brief에는 저장소 파일을 worktree 기준 상대 경로로 쓰세요: isolated 워커는 자기 사본에서 일하는데, ${w.repo}나 ${w.path} 절대 경로를 주면 실제 checkout을 고쳐요. 다른 레인과 오너는 ${w.repo}에서 일하니, 거기 파일은 절대 수정하지 마세요. 작업은 진행하면서 ${w.branch}에 커밋하세요. 추적되지 않는 설정(node_modules, .env, 빌드 결과물)은 worktree에 없으니 필요한 것은 설치하거나 링크하세요. Done-when 확인이 통과하면 이 프로젝트가 작업을 반영하는 방식대로 반영하세요(PR을 쓰는 프로젝트면 PR). 아니면 ${w.base} 위로 rebase(\`git rebase ${w.base}\`)한 뒤 \`git -C ${w.repo} merge --ff-only ${w.branch}\`를 하세요. 충돌이 나면 worktree에서 해결하고 다시 시도하세요. 강제로 밀지 말고 ${w.repo}를 reset하지 마세요. 머지한 커밋을 보고하세요. 머지 후 레인을 닫으면 게이트웨이가 worktree를 지워요.`,
	noGit: `\n\n이 폴더는 git 저장소가 아니라서 격리(isolated) 워커가 뜨지 않아요. 워커는 격리 없이 띄우세요(읽기만 하는 일은 격리가 필요 없어요). 파일을 고치는 워커라면 다른 워커와 겹치지 않는 파일만 맡기세요.`,

	replay: `${koLeads.replayLead}. 지금 처리하세요. 이미 일부는 끝났을 수 있으니 같은 동작을 반복하기 전에 확인하세요.`,
	newMessage: (target, replyTo, text) => `${koLeads.newMessageLead}. 이 메시지에는 별도 턴이 없어요. 지금 dotz_send target "${target}"${replyTo ? ` reply_to "${replyTo}"` : ""}로 답하세요(금방 끝나면 전체 답을, 아니면 언제쯤 답할지 짧게). 그다음 하던 일을 이어가세요. 최종 답은 처음 시작한 요청으로 가요.\n\n${text}`,
	waited: (seconds, target) => `${koLeads.waitedLead}: ${target}에 ${seconds}초째 아무것도 올라오지 않았어요. 지금 ${target}에 짧은 진행 메모를 올리고(dotz_send update_key "progress": 하는 일, 답이 나올 시점) 하던 일을 이어가세요.`,
	firstStart: target => `[dotz gateway] 이 설치의 첫 시작이에요. ${target}에서 먼저 말을 거세요: 짧은 메시지 몇 개로 오너에게 인사하세요(이름은 ${NAME}; 당신이 누구인지, 할 수 있는 일: 프로젝트별 채널, 모니터링, 레인, 스케줄). 그다음 오너의 환경을 읽기 전용으로 파악해도 되는지 한 번만 물어보세요: Aside에 있는 오너에 대한 메모리(aside memory list / search: 누구인지, 사람들, 프로젝트, 사이트), 로그인해 둔 사이트, 코딩 에이전트 세션과 프로젝트, 쓰는 도구와 CLI, 이 머신의 로그와 스케줄. 승낙하면 읽기 전용 워커로 진행하고, 진행 메시지 하나를 제자리에서 갱신하고(dotz_send update_key "onboarding"), 알게 된 것은 그때그때 메모리에 기록하고, 알아낸 것과 아직 모르는 것을 짧게 요약하며 끝내세요. 거절하면 시작하는 방법만 알려 주세요.`,

	inboxLaneReport: lane => `[dotz inbox] 레인 ${lane}의 보고:`,
	inboxWatchNoChannel: (watch, reason) => `[dotz inbox] watch ${watch} ${reason} (이 턴을 기다리는 사람이 없어요. 중요할 때만 dotz_send로 오너에게 알리세요):`,
	inboxWatch: (watch, reason, ch) => `[dotz inbox] watch ${watch} ${reason}, 작업 채널 ch:${ch} (최종 답이 그 채널로 가요. 아무것도 올리지 않으려면 "-" 한 글자만 답하세요):`,
	inboxMail: ch => `[dotz inbox] 작업 채널 ch:${ch}에 새 메일 (최종 답이 그 채널로 가요. 메일마다 스레드를 하나씩 dotz_channel thread로 열되 kind는 발신자, name은 메일 제목으로 하고 거기에 요약을 올리세요. 상대가 오너에게 뭔가 원하면 추천 답장과 함께 알리세요. 읽기와 처리는 zele로 하고, 보내기는 오너가 OK한 뒤에만 하세요. 아무것도 올리지 않으려면 "-" 한 글자만 답하세요):`,
	inboxSchedule: (id, every, channel) => `[dotz inbox] 예약 항목 (${id}${every ? `, ${every}분마다` : ""}) - 지금 처리하세요. 최종 답은 ${channel}로 가요:`,
	inboxThread: (thread, parent) => ` (#${parent}의 스레드 "${thread}". 답은 스레드로 가요)`,
	inboxFirst: channel => `(새 작업 채널 #${channel}: 오너는 채널 단위로 일을 맡겨요. 이 채널의 작업과 보고는 여기에 두세요. 이 채널의 일에 로그인 유지나 시간이 지나며 확인할 것이 필요하면 직접 dotz_channel setup으로 이 채널에 설정하세요.)`,
	inboxBurst: n => `(sent as ${n} messages in a row; 하나의 요청으로 함께 읽으세요)`,
	replyingTo: (author, content) => `(${author}의 메시지에 대한 답장: "${content}")`,
	workChannels: list => `(작업 채널: ${list.length ? list.join("; ") : "아직 없음"})`,
	replyIn: (_language, drifted) => (drifted ? "(직전에 오너에게 보낸 글이 한국어가 아니었어요. 오너에게 가는 글은 한국어로만 쓰세요.)" : "(오너에게는 한국어로 답하세요.)"),

	reflect: (digest, lessons) => `[dotz reflect] 지난 24시간의 야간 자기 점검이에요. 게이트웨이가 모은 데이터:\n${digest}\n
짧게 이렇게 하세요:
1. 잘못됐거나 비용이 너무 든 것을 찾으세요: 오너의 정정이나 반복된 요청, 실패했거나 멈춘 레인, 알림, 캐시 재작성.
2. 진짜 교훈마다 ${lessons}에 날짜가 붙은 줄을 하나 추가하거나 고치세요(30줄 안팎으로 유지하고, 더 이상 맞지 않거나 규칙이 이미 다루는 교훈은 지우세요). 오너에 대한 오래 갈 사실은 메모리 도구로 남기세요.
3. RULES.md나 LESSONS.md가 이미 다루는데도 되풀이된 일은 글을 더 쓴다고 나아지지 않아요. 오너에게 (dotz_send alert로) 전달 경로를 고치는 구체적인 방법(어느 파일, 훅, 브리프 footer, 확인을 바꿀지)을 보내세요.
4. 여기서 RULES.md는 절대 수정하지 마세요. 규칙 변경은 alert로 오너에게 제안하고 답을 기다리세요.
5. 마지막으로 dotz_send worklog 글 하나를 한국어로, identity의 Notices 문체로 올리세요: 첫 줄은 "야간 정리", 이어서 한 일을 쉬운 말로 "- " 글머리 항목으로(예: "- 배운 점 1개 LESSONS.md에 정리했어요", "- 고칠 거 제안 1건은 알림에 올렸어요"), 최대 4개, 영어로 된 개수 표기는 쓰지 마세요. 그 밖에는 아무것도 보내지 않아요.`,

	lessonCandidates: (stale, duplicates, over) => `\n\n코드가 고른 LESSONS.md 정리 후보예요. 지울지 합칠지는 직접 판단하세요(합칠 때는 더 최근이거나 구체적인 문장을 남기세요):${over ? `\n- ${over}` : ""}${stale.length ? `\n- 90일 넘은 줄:\n${stale.join("\n")}` : ""}${duplicates.length ? `\n- 거의 같은 줄(단어 겹침 0.6 이상):\n${duplicates.join("\n")}` : ""}`,

	auth: {
		titles: { secret: "로그인 정보가 필요해요", otp: "인증 코드가 필요해요", approve: "로그인 승인이 필요해요" },
		site: "사이트",
		expires: time => `${time} KST까지`,
		input: "입력하기",
		approve: "승인했어요",
		cancel: "취소",
		labels: { username: "아이디", password: "비밀번호", code: "인증 코드" },
		modalTitle: site => `${site} 로그인`,
		statuses: { entered: "입력을 받았어요.", approved: "승인됐어요.", cancelled: "취소됐어요.", timeout: "시간이 지나 만료됐어요." },
		notOwner: "주인만 답할 수 있어요.",
		finished: "이미 끝났거나 만료된 요청이에요.",
		received: "받았어요. 값은 게이트웨이에만 전달돼요.",
		incomplete: "비어 있는 칸이 있어요. 버튼을 다시 눌러 주세요.",
		storeFailed: "저장하지 못했어요. 버튼을 다시 눌러 주세요.",
	},

	harness: {
		locale: "ko-KR",
		common: { state: "상태", disabled: "꺼져 있어요", off: "꺼짐", set: "설정됨", none: "없음", count: n => `${n}개`, daily: time => `매일 ${time}` },
		status: { working: "작업 중", idle: "대기", starting: "시작 중", stopped: "멈춤", "rate-limited": "한도 제한", exited: "종료됨" },
		ago: { now: "방금", min: m => `${m}분`, hourMin: (h, m) => `${h}시간 ${m}분`, day: d => `${d}일`, before: d => `${d} 전` },
		fileFact: { label: "파일", missing: "아직 없어요", size: "크기", chars: n => `${n}자`, modified: "마지막 수정" },
		files: {
			"MODE.md": { label: "행동 규칙(MODE)", note: "저장소와 함께 배포되는 파일이라 여기서는 읽기만 돼요." },
			"RULES.md": { label: "내 규칙", note: "차단 명령은 바로, 나머지는 다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
			"LESSONS.md": { label: "교훈", note: "다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
			"identity/IDENTITY.md": { label: "정체성", note: "다음 세션·압축 뒤 다시 읽을 때 반영돼요." },
		},
		notOpenable: name => `"${name}" 은(는) 열 수 있는 파일이 아니에요 (MODE.md, RULES.md, LESSONS.md, identity/IDENTITY.md)`,
		settings: {
			"orchestrator.model": { label: "모델" },
			"orchestrator.thinking": { label: "추론 강도" },
			"orchestrator.rotate_tokens": { label: "새 세션으로 넘어가는 기준", unit: "토큰", hint: "대화가 이만큼 길어지면 한가한 때 핸드오버와 함께 새 세션으로 넘어가요" },
			"lanes.model": { label: "새 레인 기본 모델" },
			"lanes.thinking": { label: "새 레인 추론 강도" },
			"lanes.max_active": { label: "동시에 일하는 레인 수", unit: "개" },
			"lanes.compact_at": { label: "자동 압축 시작", unit: "토큰", hint: "레인 컨텍스트가 이만큼 차면 요약해서 줄여요" },
			"lanes.keep_recent": { label: "압축해도 남기는 최근 대화", unit: "토큰" },
			"lanes.worker_model": { label: "작업자 모델" },
			"lanes.worker_effort": { label: "작업자 추론 강도" },
			"lanes.nightly_at": { label: "야간 정리 시각", hint: "HH:MM 또는 off" },
			"lanes.nightly_compact_at": { label: "야간 압축 기준", unit: "토큰" },
			"lanes.rotate_mb": { label: "세션 파일 교체 크기", unit: "MB" },
			"lanes.max_rss_gb": { label: "프로세스 메모리 한도", unit: "GB", hint: "넘으면 같은 세션으로 다시 시작해요. 끄려면 config.json 에서 0 으로" },
			"gateway.coalesce_ms": { label: "연달아 온 메시지 묶는 시간", unit: "ms", hint: "같은 채널에서 이 시간 안에 온 메시지는 한 번에 처리해요" },
			"reflect_at": { label: "야간 회고 시각", hint: "HH:MM 또는 off" },
			"token_audit_at": { label: "토큰 감사 시각", hint: "HH:MM 또는 off" },
			"omp_update.mode": { label: "업데이트 방식", options: { check: "새 버전만 알림", install: "자동 설치 후 재시작", off: "끄기" } },
			"omp_update.at": { label: "업데이트 확인 시각", hint: "HH:MM 또는 off" },
			"backup.remote": { label: "백업 저장소 주소", hint: "비우면 이 컴퓨터에만 스냅샷을 남겨요. 비밀이 든 파일은 올리지 않아요" },
			"output_language.mode": { label: "출력 언어 점검", options: { rewrite: "다른 언어면 다시 쓰기", off: "끄기" } },
			"output_language.model": { label: "다시 쓰기에 쓸 모델", hint: "비우면 omp 의 기본 작은 모델" },
			"output_language.timeout_s": { label: "다시 쓰기 제한 시간", unit: "초" },
			"zele.enabled": { label: "메일·캘린더 확인" },
			"zele.poll_sec": { label: "확인 간격", unit: "초" },
			"zele.brief_hour": { label: "아침 브리핑 시각", unit: "시" },
			"identity.name": { label: "이름" },
			"identity.language": { label: "응답 언어", hint: "ko, en, ja … 비우면 정체성 글에서 자동 감지" },
			"identity.character": { label: "성격", hint: "정체성 파일(IDENTITY.md)이 있으면 그쪽이 우선이에요" },
			"identity.tone": { label: "말투", hint: "출력 언어 다시 쓰기의 말투 기준이기도 해요" },
		},
		nodes: {
			discord: {
				summary: { connected: n => `연결됨 · 작업 채널 ${n}개`, disconnected: "연결 끊김" },
				desc: "대화방·작업 채널·레인 스레드에 쓴 글을 받아 게이트웨이로 넘기고, 답장을 같은 곳에 올려요. 받은 글에는 👀 로 먼저 표시해요. 연결 정보(토큰·서버·소유자)는 보안상 화면에서 바꿀 수 없어요.",
				state: { off: "꺼짐 (토큰·서버·소유자 중 빠진 게 있어요)", connected: "연결됨", disconnected: err => `끊김${err ? ` · ${err}` : ""}` },
				workChannels: "작업 채널", laneThreads: "레인 스레드", token: "봇 토큰", owner: "소유자", guild: "서버",
			},
			web: {
				label: "웹 앱", summary: "이 화면 · tailnet 안에서만 열려요",
				desc: "지금 보고 있는 화면이에요. 채팅·레인·설정을 보고, 메시지를 보내면 게이트웨이를 거쳐 오케스트레이터에게 가요. 서버는 이 컴퓨터(127.0.0.1)에만 열리고, 밖에서는 Tailscale 이 로그인 신원을 붙여 들여보내요.",
				access: "접속", accessValue: "Tailscale 로 허용된 로그인만", sending: "메시지 보내기", sendingValue: "보통 / 끼워넣기 / 중단하고 보내기",
				port: "포트", tailscalePort: "Tailscale HTTPS 포트", logins: "허용된 로그인", loginCount: n => `${n}명`,
			},
			terminal: {
				label: "터미널", summary: n => `연결된 터미널 ${n}개`, none: "연결된 터미널 없음",
				desc: name => `터미널에서 "${name}모드 켜"라고 하면 그 터미널이 입력창이 돼서 쓴 글이 게이트웨이 오케스트레이터에게 가요. 꺼"라고 하면 다시 일반 터미널이에요.`,
				connected: "연결된 터미널",
			},
			schedule: {
				label: "예약 작업", summary: (n, next) => `예약 ${n}개${next}`, none: "예약 없음", next: (d, future) => ` · 다음은 ${d} ${future ? "뒤" : "전"}`,
				desc: "정해진 시각(한 번 또는 5분 이상 간격 반복)에 정해 둔 문장을 오케스트레이터에게 보내요. 오케스트레이터가 예약을 만들고 지울 수 있어요.",
				schedules: "예약", nextRun: "다음 실행", repeating: "반복 예약",
			},
			watch: {
				label: "감시", summary: (n, failing) => `감시 ${n}개${failing ? ` · 연속 실패 ${failing}개` : ""}`, none: "감시 없음",
				desc: "모델을 깨우지 않고 정해진 간격으로 명령을 실행해서, 값이 바뀌었거나 조건에 맞거나 실패했을 때만 알려요. 로그인 유지(세션 확인)도 여기서 해요. 2번 연속 실패하면 12시간에 한 번만 알리고, 복구되면 한 번 알려요.",
				watches: "감시", setups: "작업 채널별 설정", failing: "연속 실패 중",
			},
			mail: {
				label: "메일·캘린더", summary: (sec, hour) => `${sec}초마다 확인 · 아침 ${hour}시 브리핑`,
				desc: "zele 로 구글 메일·캘린더를 확인해서 새 메일은 메일 채널 스레드로, 곧 있을 일정은 알림으로, 아침에는 하루 브리핑으로 보내요. 광고·알림성 메일은 걸러요.",
				on: "켜짐 (계정이 없으면 10분마다 다시 확인)",
			},
			gateway: {
				label: "게이트웨이", summary: "메시지 묶기 · 명령 처리 · 답장 전달",
				desc: "모든 입력이 지나가는 문이에요. 같은 채널에서 연달아 온 글은 한 번에 묶어서 넘기고, /model·/restart 같은 명령과 \"한도\" 질문은 오케스트레이터를 깨우지 않고 직접 답해요. 답장은 질문한 채널로 돌려보내고, 60초 안에 답이 안 나가면 중간 보고를 요청해요. 재시작해도 답 못 한 메시지는 다시 처리해요.",
				merge: "묶는 시간", mergeValue: ms => `${ms}ms (최대 20초까지)`, direct: "직접 답하는 것", directValue: "/명령, \"한도\"",
				route: "답장 길", routeValue: "질문이 온 채널(Discord·웹·터미널)로", restart: "재시작", restartValue: "작업이 모두 끝난 뒤(최대 20분) 새 코드로 다시 시작",
			},
			orchestrator: {
				label: name => `오케스트레이터 (${name})`,
				desc: "모든 메시지를 받는 상시 비서예요(omp 세션 하나). 가벼운 일은 직접 하고, 오래 걸리는 일은 레인에 맡겨요. 사용량 한도에 걸리면 메시지를 모아 뒀다가 리셋 직후 순서대로 처리하고, 서버 오류는 최대 4번 재시도해요. 죽으면 자동으로 다시 띄우고(10분에 3번까지), 대화가 길어지면 핸드오버와 함께 새 세션으로 넘어가요. 모델을 바꾸면 새 세션으로 시작해요.",
				context: "컨텍스트", resumes: "재개 예정", cache: "캐시 유지", cacheValue: "한가할 때 50~58분에 한 번 신호(최대 12번)",
				startPrompt: "시작 프롬프트", startPromptValue: "행동 규칙 + 정체성 + 내 규칙 + 교훈 + 작업 채널 요약",
			},
			mode: {
				label: "행동 규칙 (MODE)", summary: file => `${file} · 읽기 전용`,
				desc: "오케스트레이터와 레인이 어떻게 일할지 정한 기본 계약이에요. 저장소와 함께 배포되는 파일이라 여기서는 읽기만 돼요.",
				file: "사용 중인 파일", language: "언어",
			},
			identity: {
				label: "정체성", summary: (name, language) => `이름 ${name} · 응답 언어 ${language}`,
				desc: "이름·성격·말투예요. IDENTITY.md 가 있으면 그 내용을, 없으면 설정의 성격·말투를 시작 프롬프트에 넣어요. 응답 언어는 출력 언어 점검의 기준이기도 해요.",
			},
			rules: {
				label: "내 규칙 (RULES)", summary: n => `규칙 파일 · 차단 명령 ${n}개`,
				desc: "내가 정한 상시 규칙과 금지예요. 행동 규칙보다 우선하고 레인도 읽어요. \"Blocked commands\" 줄은 오케스트레이터·레인·작업자가 실행하기 전에 막아요.",
				blocked: "차단 명령",
			},
			lessons: {
				label: "교훈 (LESSONS)", summary: "야간 회고가 쌓는 메모",
				desc: "오케스트레이터가 매일 밤 회고하면서 스스로 정리하는 메모예요(대략 30줄). 내 규칙이 항상 우선해요. 고치거나 지워도 돼요.",
			},
			lanes: {
				label: "레인", summary: (n, working, max) => `${n}개 · 작업 중 ${working} · 동시 ${max}개까지`, none: max => `없음 · 동시 ${max}개까지`,
				desc: "오래 걸리는 프로젝트 작업을 맡는 독립 세션이에요(채널 하나에 레인 하나). git 저장소면 레인마다 전용 작업 폴더(worktree)와 브랜치에서 일해서 내 작업 폴더를 건드리지 않고, 끝나서 병합되면 정리해요. 시작할 때마다 설정 파일(omp 오버레이)을 새로 써서 작업자 모델과 자동 압축 기준을 적용해요. 멈춘 레인은 자동으로 이어서 시작해요(1시간에 3번까지).",
				lanes: "레인", lanesValue: (n, working) => `${n}개 (작업 중 ${working})`, workDir: "작업 폴더", workDirValue: "git 저장소면 레인 전용 worktree",
				compaction: "압축", compactionValue: tokens => `컨텍스트 ${tokens}토큰에서 자동`,
			},
			workers: {
				label: "작업자 (서브에이전트)", running: n => ` · 실행 중 ${n}개`,
				desc: "레인이 구현·테스트·탐색을 나눠 맡기는 일꾼이에요. 레인은 계획과 검토를 자기 모델로 하고, 작업자는 더 싼 모델로 병렬 실행해요. 파일을 쓰는 작업자는 격리된 사본에서 일하고 결과를 패치로 돌려줘요. 패치는 읽어 본 뒤에만 적용할 수 있어요.",
				kinds: "종류", kindsValue: "task(구현·테스트·렌더), scout(탐색)", limit: "동시 실행 상한", limitValue: n => `레인당 ${n}개 (이 컴퓨터 사양 기준)`,
				runningFact: "실행 중", isolation: "격리", isolationValue: "쓰기 작업자는 격리 사본 + 패치 검토 후 적용",
				expensive: "비싼 모델", expensiveValue: "Fable·최고 강도는 내가 직접 요청한 때만",
			},
			outlang: {
				label: "출력 언어 점검", summary: language => `${language} 가 아니면 다시 써서 보내요`,
				desc: "내게 가는 글이 정체성 언어와 다르면(영어로 생각하다 새어 나온 경우 등) 작은 모델 한 번으로 번역해서 보내요. 언어 감지는 로컬이라 공짜고, 실패하면 원문이 그대로 나가요.",
				reference: "기준 언어",
			},
			update: {
				label: "omp 업데이트 확인", install: "자동 설치", check: "새 버전만 알림",
				desc: "매일 새 omp 버전이 있는지 확인해서 작업 로그 채널에 알려요. '자동 설치'로 두면 설치하고 모두 한가해질 때 게이트웨이를 재시작해요.",
			},
			audit: {
				label: "토큰 사용 감사",
				desc: "매일 omp 세션 기록을 훑어서 이유 없이 캐시가 깨졌거나 컨텍스트가 비정상적으로 큰 세션 같은 낭비를 찾아내요. 이상이 있으면 알림 채널로 알려요.",
			},
			reflect: {
				label: "야간 회고", summary: when => `${when} · 교훈 정리 + 백업`,
				desc: "매일 밤 전날 대화를 요약해서 오케스트레이터에게 돌아보게 하고, 배운 것을 교훈 파일에 적게 해요. 그 전에 설정 폴더를 git 스냅샷으로 남겨요. 조용한 날은 건너뛰어요.",
			},
			backup: {
				label: "백업", remote: "스냅샷 + 외부 저장소", local: "이 컴퓨터에만 스냅샷",
				desc: "매일 밤 설정·규칙·교훈을 git 으로 스냅샷해요. 저장소 주소를 적으면 밖으로도 올리는데, 비밀처럼 보이는 파일이 하나라도 있으면 올리지 않아요.",
				external: "외부 저장소", credentialed: "설정됨 (인증 정보 포함)", credentialedHint: "인증 정보가 들어 있어서 화면에서는 바꿀 수 없어요",
			},
			providers: {
				label: "공급자·한도", summary: (n, low) => (low === undefined ? `${n}곳 사용 중` : `${n}곳 사용 · 가장 적은 한도 ${low}% 남음`),
				desc: "모델 제공자(Anthropic 등) 로그인·키와 사용량이에요. 레인을 시작하기 전에 5시간 한도를 보고, 이 작업이 쓸 몫(기본 15%)을 빼고도 10%가 안 남으면 먼저 물어봐요. 7일 한도는 보여주기만 해요.",
				used: "쓰는 공급자", remaining: pct => `${pct}% 남음`,
			},
			hygiene: {
				label: "레인 야간 정리", summary: when => `${when} · 길어진 레인 압축·교체`,
				desc: "매일 정해진 시각에 한가한 레인을 살펴서, 세션 파일이 크면 새 세션으로 넘기고(핸드오버) 컨텍스트가 크면 압축해요. 일하던 레인은 건드리지 않아요. 끝난 작업자의 남은 임시 폴더도 한 시간마다 지워요.",
			},
			memguard: {
				label: "메모리 가드", summary: gb => `프로세스당 ${gb}GB 넘으면 재시작`,
				desc: "30초마다 오케스트레이터·레인 프로세스의 메모리를 보고 한도를 넘으면 같은 세션으로 다시 시작해요(엉뚱한 grep 하나가 수십 GB를 먹는 일을 막아요). 한 시간에 3번을 넘기면 알림만 보내고 멈춰요.",
			},
			guard: {
				label: "작업 가드 (omp 확장)", summary: "브리핑·패치·예산·외부 명령 점검", missing: "설치돼 있지 않아요",
				desc: "omp 쪽에 설치된 orchestrator-guard 확장이에요(게이트웨이 밖, 이 컴퓨터의 omp 설정). 작업자를 부르는 순간과 작업자가 도는 동안 아래 규칙을 강제해요. 여기서는 읽기만 돼요.",
				installed: "설치됨", notInstalled: "설치 안 됨 (규칙이 강제되지 않아요)",
				briefing: "브리핑", briefingValue: "완료 조건 필수 · 8000자·코드 40줄 제한 · 답변 800자 이내",
				patch: "패치", patchValue: "쓰기 작업자는 격리 + 패치를 읽어야 적용 가능",
				budget: "예산", budgetValue: "5시간 한도가 모자라면 막고 허락을 받아요",
				expensive: "비싼 모델", expensiveValue: "Fable·최고 강도는 내가 요청했을 때만",
				external: "외부 명령", externalValue: "push·배포·ssh·외부 전송은 작업자가 못 하고 돌려줘요",
				context: "컨텍스트", contextValue: "작업자 압축 1번: 마무리 유도, 2번: 도구 차단",
				blocked: "내 규칙의 차단 명령",
			},
		},
		edges: {
			discord: "메시지", web: "채팅", terminal: "터미널 입력", schedule: "정해진 시각", watch: "변화 감지", mail: "새 메일·일정",
			batch: "묶어서 전달", delegate: "작업 위임", parallel: "병렬 실행", mode: "행동 규칙", identity: "이름·말투", rules: "내 규칙", rulesLanes: "레인도 읽음",
			lessons: "교훈", lessonsWrite: "교훈 기록", snapshot: "스냅샷", review: "회고 요청", outlang: "답장 언어 점검", update: "새 버전 알림", audit: "낭비 알림",
			providers: "모델·한도", budget: "예산 게이트", hygiene: "야간 정리", memguard: "메모리 감시", guard: "규칙 강제",
		},
		// 프로젝트별 지도 (hub/harnessprojects.ts): 작업 채널이나 홈 채널에 묶인 레인 하나예요.
		project: {
			channelKind: { work: "작업 채널", home: "홈 채널", thread: "레인 스레드" },
			edgeIn: "메시지", edgeFiles: "지침으로 읽음", edgeFeatures: "여기서만 적용",
			globalNote: "전역 설정이에요. 프로젝트마다 따로 두지 않으니 메인 지도에서 바꿔요.",
			fallbackStep: (model, when, cap, revert) => `${model}${when ? ` · 조건 ${when}` : ""}${cap ? ` · 상한 ${cap}` : ""}${revert ? ` · 복귀 ${revert}` : ""}`,
			channel: {
				summary: (kind, purpose) => (purpose ? `${kind} · ${purpose}` : kind),
				desc: "이 프로젝트의 레인이 답하는 채널이에요. 여기에 쓴 글은 이 채널의 맥락과 함께 레인의 프로젝트로 가요.",
				kind: "종류", purpose: "목적", logins: "유지 중인 로그인", monitors: "감시", standing: "상시 처리", updated: "설정 갱신", noSetup: "이 채널에는 아직 설정이 없어요",
			},
			lane: {
				label: name => `레인 ${name}`,
				desc: "이 프로젝트를 맡은 레인이에요. 모델·강도·런타임이 전역 레인 기본과 다를 수 있고, 아래 설정에서 어느 것이 다른지 보여요.",
				state: "상태", cwd: "폴더", repo: "저장소", thread: "스레드", runtime: "런타임", fallback: "폴백 체인", none: "없음",
			},
			workers: {
				label: name => `작업자 (${name})`,
				desc: "이 레인이 띄우는 작업자예요. 모델·강도가 전역 작업자 기본과 다를 수 있어요.",
				fallback: "폴백 체인", model: "모델", effort: "강도",
			},
			files: { desc: "레인 폴더에서 찾은 프로젝트 지침 파일이에요. 이름·크기·수정 시각·첫 제목만 보여줘요.", size: "크기", modified: "마지막 수정", heading: "첫 제목", bytes: n => `${n}바이트`, folder: "폴더" },
			features: {
				label: "프로젝트 기능", summary: n => `${n}개`, none: "이 프로젝트에만 있는 건 아직 없어요",
				desc: "프로젝트 폴더에 둔 스킬과 이 프로젝트 채널에 묶인 감시예요. 여기서만 적용돼요.",
				skill: "스킬", watch: "감시", watchValue: (every, on) => `${every}분마다 · ${on} 때`,
			},
			deny: { label: "프로젝트 차단 명령", summary: n => `${n}줄`, desc: "프로젝트 지침 파일의 '## Blocked commands' 아래 '- deny:' 줄이에요. 이 프로젝트에만 적힌 규칙이에요." },
			settings: {
				model: { label: "레인 모델", hint: "바로 적용돼요. 돌고 있는 레인은 새 모델로 다시 시작해요" },
				effort: { label: "레인 강도" },
				workerModel: { label: "작업자 모델", hint: "이 레인이 다음에 띄우는 작업자부터 적용돼요" },
				workerEffort: { label: "작업자 강도" },
				runtime: { label: "런타임", hint: "레인을 다시 시작할 때 적용돼요" },
			},
		},
	},
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
