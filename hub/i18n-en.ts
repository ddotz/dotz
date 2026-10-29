// English message catalog (see hub/i18n.ts). Moved out of i18n.ts unchanged; the types come from i18n.ts as type-only imports.
import { join } from "node:path";
import { IDENTITY_FILE, NAME, paths, tzLabel } from "./config.ts";
import type { FileText, HelpText, LaneFooterArgs, RecallArgs, SettingText, WorktreeArgs } from "./i18n.ts";

// Prefixes (leads) of notes that are matched later; every note that has a lead starts with it.
export const enLeads = {
	youAre: "[dotz gateway] You are",
	replayLead: "[dotz gateway] The gateway restarted before you answered this",
	newMessageLead: "[dotz gateway] A new message arrived while you are working",
	laneReportLead: "[dotz gateway] A session report arrived while you are working",
	waitedLead: "[dotz gateway] The owner has waited",
	rateLead: "[dotz gateway] The rate limit has passed",
	providerLead: "[dotz gateway] The provider problem (billing/auth) may have been fixed",
	transientLead: "[dotz gateway] The provider had a temporary error (overloaded or network) and your last turn failed",
};
export type Leads = typeof enLeads;

// One sentence reused by every handover and, once after a compaction, by the next prompt: a fresh or compacted session
// loses what the old context held, so facts worth keeping are saved to memory before the work goes on.
const enRetainNudge = "Before continuing, save any durable owner, project or preference fact from the conversation so far that is not in memory yet with the memory tool if this runtime has one (omp: `retain`), else in the dotz data directory (owner facts in memory/owner.md, the owner's verbatim don'ts in memory/boundaries.md, rules in RULES.md, lessons in LESSONS.md, open work in state.json); skip this if there is none.";

// How a nightly or monitoring run reports an issue (hub/reflect.ts, hub/watch.ts wake turn): one line plus a choice block that the web's
// decision buttons and decision notices read (web/js/10-decision-card.js, hub/choices.ts).
const enIssue = `report it with dotz_send alert: one line for the issue that starts with the [ask] marker (a message with a choice block gets buttons whatever its marker), then a choice block of 2-4 options in this shape:
Decision: <question>
**1) <name>** ← recommended
<one-line consequence>
**2) <name>**
<one-line consequence>`;
export const en = {
	...enLeads,

	// Owner-facing text of the slash-command cards (hub/control.ts runCommand); lane -> session, worker -> subagent.
	cmd: {
		failed: "That did not work",
		applyAnyway: "Apply anyway",
		forceNote: "This session is running, so changing its model or effort rewrites its prompt cache. Apply it anyway?",
		cancel: "Cancel",
		none: "-",
		notRunning: "Not running",
		model: "Model",
		effort: "Effort",
		sessions: "Sessions",
		newSessions: "New sessions",
		subagents: "Subagents",
		account: "Account",
		accountId: "Account id",
		accountTitle: "Claude account",
		lastSwitch: "Last account switch",
		link: "Link",
		statusTitle: "Status",
		contextTitle: "Context",
		sessionsTitle: "Sessions",
		modelsTitle: "Models",
		modelsNote: "The buttons switch the main agent. For another target: /model <target> <model>.",
		noSessions: "No sessions yet.",
		discord: { connected: "Connected", disconnected: "Disconnected", off: "Off" },
		compaction: { queued: "Compaction queued", compacting: "Compacting", done: "Compacted", error: "Compaction failed" },
		compactTitle: {
			queued: (who: string) => `${who} compacts right after this turn`,
			compacting: (who: string) => `${who} is compacting`,
			done: (who: string) => `${who} compacted`,
			error: (who: string) => `${who} could not compact`,
		},
		compactNote: "Compacting rewrites the conversation into a summary, so the next turn writes the prompt cache once more.",
		until: (time: string) => `until ${time}`,
		sessionsValue: (count: number, activeLabel: string, active: number) => `${count} · ${activeLabel} ${active}`,
		usage: (percent: string, used: string, window: string) => `${percent} (${used} / ${window})`,
		modelTitle: (who: string) => `${who} model`,
		effortTitle: (who: string) => `${who} effort`,
		updated: (who: string) => `${who} updated`,
		unchanged: (who: string) => `${who} unchanged`,
		applied: { live: "Applied now", restarted: "Restarted on it", "next-start": "From the next start" } as Record<string, string>,
		restartGateway: "Gateway restart queued",
		restartGatewayNote: (minutes: number) => `It restarts once the main agent and every session have nothing left to do; you get a notice if that takes longer than ${minutes} minutes.`,
		restartMain: (who: string) => `${who} is restarting`,
		restartSession: (who: string) => `Session ${who} restarted`,
		stopping: (who: string) => `Session ${who} is stopping`,
		resumed: (who: string) => `Session ${who} resumed`,
		aborted: (who: string) => `${who} turn aborted`,
		providersTitle: "Providers",
		noProviders: "No providers.",
		signedIn: (account?: string) => `Signed in${account ? ` (${account})` : ""}`,
		apiKey: "API key",
		disconnected: "Not connected",
		models: (count: number) => `${count} models`,
		inUse: "in use",
		addable: (list: string) => `Can be added: ${list}`,
		loginPick: "Which provider do you want to sign in to?",
		loginNone: "No sign-in in progress",
		loginCancelled: (provider: string) => `${provider} sign-in cancelled`,
		loginDone: (provider: string) => `${provider} signed in`,
		loginOpen: "Open the link to sign in",
		loginMore: (provider: string) => `One more value is needed. Send it as /login ${provider} <value>.`,
		loginCode: (provider: string) => `On another device, send the full address you land on (or the code) as /login ${provider} <address or code>.`,
		loginAfter: "Once you approve, it shows up in /providers.",
		logoutDone: (provider: string) => `${provider} signed out`,
		logoutNote: "Work that is already running keeps the old login until it restarts.",
		quotaTitle: "Usage limits",
		noQuota: "No usage information.",
		left: (value: string) => `${value} left`,
		resets: (time: string) => `resets ${time}`,
		windows: { "anthropic:5h": "5 hours", "anthropic:7d": "7 days", "anthropic:7d:opus": "7 days · Opus", "anthropic:7d:sonnet": "7 days · Sonnet" } as Record<string, string>,
		problem: { expired: "The login expired; it renews on the next request.", rate_limited: "Reading usage is rate-limited right now.", failed: "Could not read usage." } as Record<string, string>,
		readFailed: "Could not read usage (no Anthropic account found).",
		noLimits: "No limit information.",
		help: (levels: string, minutes: number): HelpText => ({
			title: "Commands",
			groups: [
				{ label: "View", items: [["/status", "State of the main agent, sessions and Discord"], ["/context", "Context usage per process"], ["/lanes", "Sessions and their models"], ["/quota", "Usage limits per provider"], ["/providers", "Signed-in providers and their models"]] },
				{ label: "Models", items: [["/model [target] [model] [effort]", "Show or change a model. Targets: orchestrator, lanes (new sessions), workers (subagents) or a session"], ["/effort <target> <level>", `Change the effort (${levels})`], ["/compact <target>", "Compact a context"]] },
				{ label: "Sessions", items: [["/stop <session>", "Pause a session (continue it later)"], ["/resume <session> [text]", "Continue a paused session, or send text to a live one"], ["/abort [target]", "Cancel the current turn (default: orchestrator)"], ["/restart <target>", `Restart a process. gateway waits until all work is done (notice after ${minutes} min)`]] },
				{ label: "Accounts", items: [["/login [provider]", "Sign in; /login cancel aborts"], ["/logout <provider>", "Sign out and remove the key"], ["/account [id|alias|auto]", "The Claude account in use and why; pick one, or back to automatic"], ["/account alias <id> <alias>", "Name an account (just <id> clears it)"]] },
			],
			note: "Changing the model or effort of a running session needs --force, because its prompt cache is rewritten. Discord also takes ! instead of /. A model can be a unique part of its name (\"opus\").",
		}),
	},

	recall: (a: RecallArgs) => `[dotz gateway] You are ${NAME}, the dotz orchestrator hosted headless by the gateway.\n\nIdentity (who you are and how you talk):\n${a.identity}\n\nContract:\n\n${a.mode}\n\nOwner rules (${paths.rules}; they override the contract):\n${a.rules}\n\nLessons (${paths.lessons}):\n${a.lessons}\n\nOwner memory (${paths.memory}; before asking the owner anything, check here and grep ${paths.observations}):\n${a.memory}\n\nWork channel setups (dotz_channel list for login health):\n${a.setups}\n\nCurrent state.json:\n${a.state}`,
	identityFallback: (character: string, tone: string) => `Name: ${NAME}\nCharacter: ${character}\nTone: ${tone}\nSpeak in this character and tone in every reply.`,
	handover: (previous: string, tail: string) => `\n\n[handover] The previous conversation (${previous}) was rotated to keep the context small. Its most recent exchanges, oldest first; continue any open thread from here:\n${tail}\n\n${enRetainNudge}`,
	laneHandover: (previous: string, tail: string | undefined) => `[handover] The previous conversation (${previous}) was rotated.${tail ? ` Its most recent exchanges, oldest first:\n${tail}\n\n${enRetainNudge}` : ""}`,
	retainNudge: enRetainNudge,
	personalAskNote: "[dotz gateway] Your last message looks like it asks for personal or security data (card, address, phone, ID number, password and the like) in chat. Ask for such values only through dotz_auth kind=form (or secret), never in chat. Correct the message you sent and ask again through the form.",
	pendingAsksHead: "Session questions waiting for the owner's answer",
	pendingAskEntry: (lane: string, at: string, text: string, cutFile?: string) => `- session ${lane} (asked ${at}):\n${text}${cutFile ? `\n... (cut; the full question is in ${cutFile})` : ""}`,
	keepalive: "[keepalive] Cache keepalive from the gateway. Reply only: ok. No tools, no sends, no state edits.",

	orchRate: (held: number) => `${enLeads.rateLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchProvider: (held: number) => `${enLeads.providerLead}. Continue the request you were handling when it stopped.${held ? ` ${held} message(s) that arrived while you were paused come next, oldest first.` : ""}`,
	orchTransient: `${enLeads.transientLead}. Continue the request you were handling when it stopped.`,

	laneStopped: "[dotz gateway] Your process was restarted after it stopped responding. Continue the last request.",
	laneRate: `${enLeads.rateLead}. Continue the work you were doing when it stopped.`,
	laneProvider: `${enLeads.providerLead}. Continue the work you were doing when it stopped.`,
	laneTransient: `${enLeads.transientLead}. Continue the work you were doing when it stopped.`,
	// The one worklog / lane line when a fallback chain moves a process (or one of its task workers) to its next model.
	modelFallback: (from: string, to: string, reason?: string, worker?: boolean) => `${worker ? "Task subagent model fallback" : "Model fallback"}: ${from} → ${to}${reason ? ` (${reason.replace(/\s+/g, " ").trim().slice(0, 120)})` : ""}`,
	// Hub-driven chain (conditional entries): a switch, a return to an earlier entry, and every entry spent.
	fallbackMove: (from: string, to: string, why: "quota" | "error" | "cap" | "revert", back?: string) => `${why === "revert" ? "Model back" : "Model fallback"}: ${from} → ${to} (${{ quota: "usage limit reached", error: "provider error", cap: "spend cap reached", revert: "limit reset" }[why]}${back ? `; back on the subscription around ${back}` : ""})`,
	fallbackExhausted: (model: string, until: string) => `Model fallback: ${model} reached its spend cap and no fallback model is left. Paused until ${until}.`,
	// The runtime's own fallback walk is undone: the process goes back to its configured model (or this runtime cannot).
	modelReverted: (model: string) => `Back on the original model (${model})`,
	fallbackFresh: (to: string, keyed: boolean, again: boolean, workers = false) => `\n\n[dotz gateway] You now run on ${to} in a fresh conversation (a model switch never continues the old conversation: its whole prompt cache would be written again).${keyed ? ` This is the API-key fallback: the subscription hit its usage limit. ${workers ? "Task subagents and sessions run on the same API key too (billed per token, sharing its monthly cap): hand off only the heavy work that needs it." : "Answer and do light work yourself; task subagents and sessions do not run on the API key, so put heavier work in state.json open_tasks and tell the owner it starts after the reset."} dotz moves you back to the subscription in a fresh conversation as soon as the limit lifts.` : " The subscription is usable again: pick up the work deferred in state.json open_tasks."}${again ? " The owner's last request above failed on the limit and was not answered: answer it now." : ""}`,
	apiStart: (model: string) => `API key in use: the subscription hit its usage limit, so the orchestrator answers on ${model}; no sessions or subagents until the reset.`,
	apiEnd: (model: string) => `API key no longer in use: the orchestrator is back on ${model} (subscription).`,
	modelNoRevert: "This runtime cannot switch models, so it stays on the fallback until restarted.",
	ownerAnswerNudge: "(Owner message: answer it at your next tool boundary with one short note before that tool call, what you will do and when; the final report is not the first answer.)",
	laneOwnerResumed: "[dotz gateway] The owner resumed you. Continue the work you were doing.",
	laneRuntimeRefused: (lane: string, from: string, to: string) => `Session ${lane} cannot be resumed: its conversation was made by ${from}, and sessions now run on ${to}, which cannot take it over (the process would die at once, and the conversation and its prompt cache would break). Reply "handover" (or "인계") to continue it as a new conversation of the same session, handed the previous conversation's recent exchanges, its brief and its last report; the message just sent goes along.`,
	laneRuntimeHandover: (from: string, to: string, cwd: string, brief: string, lastReport: string) => `[dotz gateway] Your previous conversation was made by ${from}; sessions now run on ${to}, which cannot resume it, so you continue in a fresh conversation. You keep your folder (${cwd}), model and goal. Read your brief (${brief}) and your last report (${lastReport}), check the current state of the work (git status, the files the brief names), then handle the owner's message below.`,
	laneOwnerRestarted: "[dotz gateway] Your process was restarted by the owner (settings changed). Continue the work you were doing.",
	laneMemory: (used: string, limit: string) => `[dotz gateway] Your process used ${used} GB of memory (limit ${limit} GB), so the gateway restarted it on the same conversation; any task subagents you had running stopped too. omp's grep, cat and find run inside your own process: do not point them at huge trees (~, ~/Library, /) or multi-GB files, and quote paths with spaces. Check what your subagents finished, relaunch the rest, and continue the work you were doing.`,
	laneGatewayRestarted: "[dotz gateway] The gateway restarted while you were working, which also stopped any task subagents you had running. Check what they finished (patches, files, commits), relaunch the rest, and continue; if an owner message was cut off mid-turn, handle it too.",
	workFailed: (desc: string, id: string, reason: string) => `[dotz gateway] Your background task "${desc}" (${id}) failed: ${reason}. No turn of yours has taken it up. It is yours to finish: check what it already produced (commits, files, its result), fix the cause (a transient error: run it again; a wrong category, model or brief: correct it and relaunch), and finish the owner's request. Do not ask the owner whether to retry; report the result, and ask only for a decision or a credential only he can give.`,
	stallNudge: (open: number, current: string) => `[dotz gateway] Your turn ended with ${open} plan task(s) still open${current ? ` (now: ${current})` : ""} and nothing to wait for. Go on with them now. If a task really waits on the owner or on outside work, say so in one line and mark it so in your plan instead of leaving it open.`,
	laneRotated: (why: string, cwd: string, brief: string, lastReport: string) => `[dotz gateway] Your conversation was rotated to a fresh one (${why}) to keep the context small. You keep your folder (${cwd}), model and goal. Read your brief (${brief}) and your last report (${lastReport}), check the current state of the work (git status, the files the brief names), and continue from there. Do not start new work and do not report: if nothing is open, reply with the single word "ready".`,
	heldMessages: (text: string, held: string[]) => `${text}\n\n${held.length} owner message(s) arrived while you were paused; handle each, oldest first:\n\n${held.join("\n\n---\n\n")}`,

	footer: (a: LaneFooterArgs) => `\n\n---\n[dotz lane ${a.lane}] You are a session of ${NAME}: a full omp orchestrator for this folder with one goal. The final message of each turn is your report: ${NAME} relays it and the owner reads it in the session channel. Keep it to ~800 characters in the report shape of ${a.mode} (Reporting): the first line is the outcome, led by a tone marker [done]/[run]/[ask]/[fail] ([ask] only when the owner must choose, with a choice block; a request to ${NAME} is a [done]/[run]/[fail] report with the "For ${NAME}:" line, never [ask]); then, only when the owner must answer something, a **Decision needed** paragraph of numbered questions, each with its options and your recommendation; then at most 3-4 bullets of what changed and how you checked it (paths, the Done-when check you ran yourself, the merged commit); last, one "For ${NAME}:" line for what the orchestrator handles, never mixed with the owner's questions. The owner may write to you directly. Do not message Discord or other people yourself, and never put secrets in a report. An owner message ("[owner via web]" / "[owner via Discord]") can reach you mid-turn: answer it at your next tool boundary with one short note before that tool call (what you will do about it, and when), not only in the final report; the gateway shows that note to the owner where he wrote, at once. Before you start, read and follow ${a.mode} (sections Sessions and subagents, Reporting, Browser and testing), ${IDENTITY_FILE} (voice) and the owner's standing rules in ${paths.rules} (they override your defaults). Plan and review yourself; run implementation and grind work as task subagents (subagent model ${a.workerModel} via modelRoles.task), and review a subagent's diff yourself before applying or merging it. Do not queue independent slices behind one subagent: this machine runs up to ${a.slots} task subagents at once, so fan independent slices (different files, or separable sections merged one by one) out in one batch; keep one subagent only for work that must be sequential. Size the work once at the start (heavy: new module, security or permissions, external integration, DB schema, concurrency, cross-domain refactor; unsure is heavy; never downgrade): light = 1-2 success criteria and one proof, heavy = 3+ (happy, edge, regression) with a proof each and a reviewer pass. Passing tests is not done: prove the changed behavior on its real surface (command, screen, API). Take reversible choices inside the request and budget yourself and note them in the report; ask the owner only at the confirmation gates (secrets, payments, external blast radius, destructive steps) or for taste. Write tool-call intents in the owner's language, 2-6 words, and tell your subagents the same. Keep your todo list true as you go: mark a task done the moment it is, start the next one, and drop or reword one that changed; the owner watches it as your progress.${a.worktree}`,
	worktree: (w: WorktreeArgs) => `\n\nYou work in your own git worktree ${w.path} on branch ${w.branch}, split from ${w.repo} (${w.base}); paths under ${w.repo} in your brief mean the same files under ${w.path}. In subagent briefs write repo files as paths relative to the worktree: an isolated subagent gets its own copy, and an absolute ${w.repo} or ${w.path} path makes it edit the real checkout. Other sessions and the owner work in ${w.repo}: never edit files there. Commit your work on ${w.branch} as you go. Untracked setup (node_modules, .env, build output) is not in the worktree: install or link what you need. When the Done-when check passes, land it the way this project lands work (a PR if it uses them); otherwise rebase onto ${w.base} (\`git rebase ${w.base}\`), then \`git -C ${w.repo} merge --ff-only ${w.branch}\`. On a conflict, resolve it in your worktree and retry; never force, never reset ${w.repo}. Report the merged commit. The gateway removes your worktree when the session is closed after the merge.`,
	noGit: `\n\nThis folder is not a git repository, so isolated task subagents cannot start here: run subagents without isolation (read-only work needs none), and if a subagent must edit files, keep its slice to files no other subagent touches.`,

	replay: `${enLeads.replayLead}. Handle it now; it may be partly done already, so check before repeating an action.`,
	newMessage: (target: string, replyTo: string | undefined, text: string) => `${enLeads.newMessageLead}. If its full answer is ready now (a quick question), send it with dotz_send target "${target}"${replyTo ? ` reply_to "${replyTo}"` : ""}: that settles the message, it counts as answered and never comes back as a turn. Otherwise send nothing: it comes back as its own turn when you are idle. Then continue the current work; your final answer still goes to the request you started with.\n\n${text}`,
	// The one leading line of an owner prompt that says what runs now (workers named by the hub from its own state; no model call).
	nowRunning: "[running now]",
	nowLanes: (n: number, body: string) => `sessions ${n}(${body})`,
	nowLaneBusy: "working",
	nowWorkers: (n: number, names: string) => `subagents ${n}${names ? ` ${names}` : ""}`,
	nowOrchestrator: (n: number, names: string) => `orchestrator subagents ${n}${names ? `(${names})` : ""}`,
	firstStart: (target: string) => `[dotz gateway] First start of this install. Speak first in ${target}: greet the owner in a few short messages as ${NAME} (who you are, what you can do: channels per project, monitoring, sessions, schedules). Then ask once whether you may learn their setup, read-only: Aside's memory of them (aside memory list / search: who they are, people, projects, sites) and the sites they are signed in to, coding agent conversations and their projects, tools and CLIs in use, logs and schedules on this machine. On yes, do it with read-only subagents, keep one progress message updated in place (dotz_send update_key "onboarding"), record what you learn in memory as you go, and end with a short summary of what you learned and what is still missing. On no, just say how to start.`,

	inboxLaneReport: (lane: string) => `[dotz inbox] session report from ${lane}:`,
	inboxLaneReports: (n: number) => `[dotz inbox] ${n === 1 ? "session report" : `${n} session reports`} (routine progress stays in report.md and the what-runs-now line):`,
	laneReportSteer: (body: string) => `${enLeads.laneReportLead}. Act on it now if it needs you (a result to pass on, a question, a failure): pass it on with dotz_send or answer the session with dotz_lane, then continue the current work; it does not come back later.\n\n${body}`,
	// A progress report of a running turn every 5 minutes (hub/livestatus.ts); never rewritten by a model.
	liveStatus: (minutes: number, since: string, now: string, lanes: string, workers: string) => `[run] Still working, ${minutes} min so far.${since ? `\nSince the last report: ${since}` : ""}${now ? `\nNow: ${now}` : ""}${lanes ? `\nSessions: ${lanes}` : ""}${workers ? `\nSubagents: ${workers}` : ""}`,
	liveMore: (n: number) => `+${n} more`,
	inboxWatchNoChannel: (watch: string, reason: string) => `[dotz inbox] watch ${watch} ${reason} (no one is waiting for this turn). If it is a failure, an anomaly or flapping, ${enIssue}\nIf it is not an issue, post nothing to alert; one dotz_send worklog line only:`,
	inboxWatch: (watch: string, reason: string, ch: string) => `[dotz inbox] watch ${watch} ${reason} for work channel ch:${ch} (your final answer goes there; reply "-" alone to post nothing). If it is a failure, an anomaly or flapping, ${enIssue}\nIf it is not an issue, post nothing to alert; one dotz_send worklog line only:`,
	inboxMail: (to: string) => `[dotz inbox] new mail; its conversation already exists (${to}) and your final answer goes there (open no thread). Summarize it there. If a reply is warranted, ask with the send-approval block: quoted lines "> 받는이: ...", "> 제목: ..." (a mail always carries its 첨부 line: "> 첨부: name (size)" for each file that goes out, else "> 첨부: 없음"), the quoted body, then "결정: 보낼까요? (<mail id>)" with 1) 보내기 / 2) 고치기 / 3) 보내지 않기. If something must be decided first (for example which file to send), ask that as a choice first and show the draft after the answer. If the gateway already posted a reply draft ([ask]) in this conversation, do not write another. Read or act with zele, sending only after the owner picks 1) 보내기 there. If no reply is needed, just summarize; reply "-" alone to post nothing:`,
	mailNote: (source: string, id: string, subject: string) => `(This conversation is one mail: ${source} ${id}, "${subject}". Any reply, send, forward or trash: draft first as the send-approval block (1) 보내기 / 2) 고치기 / 3) 보내지 않기) and act only after the owner's explicit OK here.)`,
	textsReport: (lines: string) => `[dotz gateway] Some of this install's text overrides (<data dir>/custom/texts.json) no longer fit this version:\n${lines}\nRe-check each one against the new shipped text (bun hub/texts-cli.ts show <key>), then rewrite it with \`bun hub/texts-cli.ts set <key> --file <file>\` or delete the entry. This notice comes once per problem. Tell the owner in one line what you changed.`,
	carryOver: (where: string, read: string, stat: string, files: string) => `[dotz update] Changes made directly in this install's dotz code were saved before the update (this notice comes once per backup). Saved: ${where}\nChanged: ${stat}\n${files}\nDo this: 1) Read the diff with \`${read}\`. 2) Move each change to the custom layer where it fits: texts to <data dir>/custom/texts.json (bun hub/texts-cli.ts), features to <data dir>/features, rules to RULES.md. 3) For a change that only makes sense in dotz core, write a short Korean report for the dotz maintainer in the worklog (no secrets or personal data) and offer to open a GitHub issue on ddotz/dotz. 4) Then tell the owner in one message what was carried over and what was not. Never edit the dotz code.`,
	inboxSchedule: (id: string, every: number | undefined, channel: string) => `[dotz inbox] scheduled (${id}${every ? `, every ${every} min` : ""}) - do it now; your final answer goes to ${channel}:`,
	inboxThread: (thread: string, parent: string) => ` (thread "${thread}" in #${parent}; your answer goes into the thread)`,
	inboxFirst: (channel: string) => `(new work channel #${channel}: the owner hands out work by channel. Keep this channel's work and reports here. If its work needs a login kept alive or something checked over time, set that up for this channel with dotz_channel setup yourself.)`,
	inboxBurst: (n: number) => `(sent as ${n} messages in a row; read them together as one request)`,
	replyingTo: (author: string, content: string) => `(replying to ${author}: "${content}")`,
	// A decision answer: each block's question with the chosen option, and the start of the message that asked (hub/intake.ts).
	decisionAnswer: (picks: { q: string; n: number; label: string; note?: string }[]) => `Decision answer: ${picks.map((p, i) => `${picks.length > 1 ? `${i + 1}) ` : ""}${p.q || "-"} -> ${p.n}) ${p.label}${p.note ? ` - ${p.note}` : ""}`).join("; ")}`,
	decisionAsked: (quote: string) => `(this answers your question: "${quote}")`,
	workChannels: (list: string[]) => `(work channel list, not this message's channel: ${list.length ? list.join("; ") : "none yet"})`,
	// Discord channel names the gateway creates, and the done marker of a lane thread.
	channelNames: { chat: "chat", alert: "alerts", worklog: "worklog", mail: "mail", workCategory: (name: string) => `${name} work` },
	threadDone: "Done. This thread is archived in an hour.",
	laneParked: "Stopped. Write here to pick this session back up from where it left off.",
	replyIn: (language: string, drifted: boolean) => drifted ? `(Your last text for the owner was not in ${language}. Write everything for the owner in ${language} only.)` : `(Answer the owner in ${language}.)`,
	handoffNote: "(Your last reply carried the For you / Now / Next handoff labels. Replies go to the owner as chat messages: no routing line and no Ask / For you / Now / Next block.)",

	reflect: (digest: string, lessons: string) => `[dotz reflect] Nightly self-review of the last 24h. Data from the gateway:\n${digest}\n
Do this, briefly:
1. Find what went wrong or cost too much: owner corrections or repeated asks, failed or stuck lanes, alerts, cache rewrites.
2. For each real lesson add or update one dated line in ${lessons} (keep it under ~30 lines; delete lessons that no longer apply or that a rule already covers). For each owner correction or reaction above, add one sourced line to ${paths.observations}; move a durable owner preference or context (stated plainly, or seen twice there) to ${paths.owner}, and a "don't" in the owner's own words to ${paths.boundaries}, verbatim with its source. Only what the owner said or did; never write about other people there.
3. If there is an issue (a failure, an anomaly, a repeated mistake, a token leak, something that recurred although RULES.md or LESSONS.md already covers it), once, ${enIssue}
4. Never edit RULES.md here; offer a rule change as an option and wait for the owner's answer.
5. Finish with one dotz_send worklog line in the identity's language and Notices style, starting "Nightly review: ...". If nothing was wrong, that one line is all you send: nothing to alert.`,

	// Appended to `reflect` only when LESSONS.md has stale or near-duplicate lines or is over its byte cap (hub/reflect.ts lessonCandidates).
	// Appended to `reflect` with the lessons no "(enforced: ...)" carries: all of them on a day with corrections, else those broken on 2+ nights (hub/reflect.ts lessonChecks).
	lessonRepeats: (rows: { line: string; score: number; broken: number; likely: boolean }[], today: string) => `\n\nLessons nothing enforces yet, checked against today's corrections. Judge by meaning, not by the words: the score is only how many of a lesson's words a correction repeats ("likely" = 0.4 or more), and "broken N" counts the nights it was already found broken. For each lesson that was really broken today: add ${today} to its "(broken: ...)" list (start one if missing), then fix it at the highest level that works: remove the cause in the code or this contract, then a guard or check whose message names the right way, then a test; reword only a pure judgment call (and add the failure as an example). After a structural fix end the line with "(enforced: <the guard, check or test>)"; delete a lesson once its mistake cannot happen. A lesson broken on two or more nights is not reworded again: it gets the structural fix now. Leave the others as they are:\n${rows.map(r => `${r.line}${r.broken ? ` [broken ${r.broken}]` : ""}${r.likely ? ` [likely ${r.score}]` : ""}`).join("\n")}`,
	// Appended to `reflect` when observations.md has lines older than 90 days (hub/reflect.ts).
	staleObservations: (stale: string[]) => `\n\nObservations older than 90 days in ${paths.observations}: delete them (move a pattern that still holds to owner.md or LESSONS.md first):\n${stale.join("\n")}`,
	lessonCandidates: (stale: string[], duplicates: string[], over: string) => `\n\nLESSONS.md cleanup candidates picked by code; you decide which to delete or merge (keep the newer or more specific wording):${over ? `\n- ${over}` : ""}${stale.length ? `\n- Older than 90 days:\n${stale.join("\n")}` : ""}${duplicates.length ? `\n- Near-duplicates (token overlap >= 0.6):\n${duplicates.join("\n")}` : ""}`,

	// Owner-facing strings of the Discord login-auth prompts (hub/auth.ts).
	auth: {
		titles: { secret: "Login details needed", otp: "Verification code needed", approve: "Login approval needed", form: "Personal details needed" },
		site: "Site",
		expires: (time: string) => `Until ${time} ${tzLabel()}`,
		input: "Enter",
		approve: "I approved",
		cancel: "Cancel",
		labels: { username: "Username", password: "Password", code: "Verification code" },
		formLabels: { name: "Name", phone: "Phone number", email: "Email", postal_code: "Postal code", address1: "Address", address2: "Address line 2", card_holder: "Name on card", card_number: "Card number", card_expiry: "Expiry (MM/YY)", card_cvc: "CVC", birth_date: "Date of birth", id_number: "ID number", account_number: "Account number", other: "Other" } as Record<string, string>,
		openForm: "Open the form in the app",
		formHint: "Values are taken only in the app's form, never in chat. Open the app with the button below.",
		formHintNoLink: "Values are taken only in the app's form, never in chat. Open the app.",
		formWebOnly: "This value is taken only in the app's form.",
		modalTitle: (site: string) => `${site} login`,
		statuses: { entered: "Received.", approved: "Approved.", cancelled: "Cancelled.", timeout: "Expired without an answer." },
		notOwner: "Only the owner can answer this.",
		finished: "This request is already finished or expired.",
		received: "Received. The value goes only to the gateway.",
		incomplete: "Some fields were empty. Press the button again.",
		storeFailed: "Could not save it. Press the button again.",
		answerFailed: "Could not pass your answer on. Type it in the channel instead.",
		noteLabel: "Tell us more",
		noteMissing: "The text was empty. Press the button again and write it.",
	},

	// Owner-facing strings of the 구성 map (hub/harness.ts); `locale` formats its dates and numbers.
	harness: {
		locale: "en-US",
		common: { state: "State", disabled: "Turned off", off: "Off", set: "Set", none: "None", count: (n: number) => `${n}`, daily: (time: string) => `daily ${time}`, na: "Not applicable", unit: { s: (n: number) => `${n} s`, min: (n: number) => `${n} min`, h: (n: number) => `${n} h` } },
		status: { working: "Working", idle: "Idle", starting: "Starting", stopped: "Stopped", "rate-limited": "Rate-limited", exited: "Exited" } as Record<string, string>,
		ago: { now: "just now", min: (m: number) => `${m} min`, hourMin: (h: number, m: number) => `${h} h ${m} min`, day: (d: number) => `${d} d`, before: (d: string) => `${d} ago` },
		fileFact: { label: "File", missing: "Not there yet", size: "Size", chars: (n: string) => `${n} chars`, modified: "Last modified" },
		files: {
			"MODE.md": { label: "Behaviour rules (MODE)", note: "Ships with the repository, so it is read-only here." },
			"RULES.md": { label: "My rules", note: "Blocked commands apply at once; the rest is picked up the next time it is read, after a new conversation or compaction." },
			"LESSONS.md": { label: "Lessons", note: "Picked up the next time it is read, after a new conversation or compaction." },
			"identity/IDENTITY.md": { label: "Identity", note: "Picked up the next time it is read, after a new conversation or compaction." },
		} as Record<string, FileText>,
		notOpenable: (name: string) => `"${name}" is not a file you can open (MODE.md, RULES.md, LESSONS.md, identity/IDENTITY.md)`,
		settings: {
			"orchestrator.model": { label: "Model" },
			"orchestrator.thinking": { label: "Thinking effort" },
			"orchestrator.rotate_tokens": { label: "Switch-to-new-conversation threshold", unit: "tokens", hint: "When the conversation gets this long, it moves to a new conversation with a handover while idle" },
			"lanes.model": { label: "Default model for new sessions" },
			"lanes.thinking": { label: "Thinking effort for new sessions" },
			"lanes.max_active": { label: "Sessions working at once", unit: "sessions", hint: "Unset, it is computed from this computer's free memory and cores. A number here is a hard cap" },
			"lanes.compact_at": { label: "Auto-compaction starts at", unit: "tokens", hint: "When a session's context fills this far, it is summarized and shrunk" },
			"lanes.keep_recent": { label: "Recent conversation kept when compacting", unit: "tokens" },
			"lanes.worker_model": { label: "Subagent model" },
			"lanes.worker_effort": { label: "Subagent thinking effort" },
			"lanes.nightly_at": { label: "Nightly cleanup time", hint: "HH:MM or off" },
			"lanes.nightly_compact_at": { label: "Nightly compaction threshold", unit: "tokens" },
			"lanes.rotate_mb": { label: "Conversation file rotation size", unit: "MB" },
			"lanes.max_rss_gb": { label: "Process memory limit", unit: "GB", hint: "Above this, the process restarts on the same conversation. To turn it off, set 0 in config.json" },
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
				desc: "Receives what is written in chat rooms, work channels and session threads, passes it to the gateway, and posts the reply in the same place. Received messages are marked with 👀 first. Connection details (token, server, owner) cannot be changed from this screen for security.",
				state: { off: "Off (token, server or owner is missing)", connected: "Connected", disconnected: (err: string) => `Disconnected${err ? ` · ${err}` : ""}` },
				workChannels: "Work channels", laneThreads: "Session threads", token: "Bot token", owner: "Owner", guild: "Server",
			},
			web: {
				label: "Web app", summary: (tailnet: boolean) => (tailnet ? "This screen · reachable only inside the tailnet" : "This screen · this computer only"),
				desc: (host: string, tailnet: boolean) => `The screen you are looking at. See chats, projects, sessions and settings; a message you send goes through the gateway to the orchestrator. The server listens only on this computer (${host})${tailnet ? "; from outside, Tailscale attaches the login identity and lets you in." : ". Tailscale is not set up, so it does not open from other devices."}`,
				access: "Access", accessValue: (tailnet: boolean, logins: number) => (tailnet ? `Only logins allowed through Tailscale (${logins})` : "This computer only"),
				port: "Port", tailscalePort: "Tailscale HTTPS port", logins: "Allowed logins", loginCount: (n: number) => `${n}`,
			},
			terminal: {
				label: "Terminal", summary: (n: number) => `Connected terminals: ${n}`, none: "No terminals connected",
				desc: (_name: string) => `Run /dotz on in a terminal and that terminal becomes an input box: what you type goes to the gateway orchestrator. Run /dotz off and it is a normal terminal again.`,
				connected: "Connected terminals",
			},
			schedule: {
				label: "Schedules", summary: (n: number, next: string) => `${n} scheduled${next}`, none: "No schedules", next: (d: string, future: boolean) => ` · next ${future ? `in ${d}` : `was ${d} ago`}`,
				desc: (min: number) => `Sends a prepared sentence to the orchestrator at a set time (once, or repeating at intervals of ${min} minutes or more). The orchestrator can create and delete schedules.`,
				schedules: "Schedules", nextRun: "Next run", repeating: "Repeating schedules",
			},
			watch: {
				label: "Monitoring", summary: (n: number, failing: number) => `Monitoring: ${n}${failing ? ` · failing in a row: ${failing}` : ""}`, none: "No monitoring",
				desc: (after: number, every: string) => `Runs a check script at a set interval without waking the model, and tells you only when the value changed, a condition matched, or it failed. Keeping logins alive (expiry checks) is done here too. After ${after} failures in a row it notifies once per ${every}, and once more when it recovers.`,
				watches: "Monitoring", setups: "Per-work-channel setups", failing: "Failing in a row",
			},
			mail: {
				label: "Mail and calendar", summary: (sec: number, hour: number) => `Checks every ${sec} s · morning briefing at ${hour}:00`,
				desc: "Checks Google mail and calendar with zele: new mail goes to a thread in the mail channel, upcoming events become notifications, and a daily briefing arrives in the morning. Promotional and notification mail is filtered out.",
				on: (retry: string) => `On (rechecks every ${retry} if there is no account)`, missing: "Not applicable (not installed on this computer)",
			},
			gateway: {
				label: "Gateway", summary: "Merge messages · handle commands · deliver replies",
				desc: (after: string) => `The door every input goes through. Consecutive messages in the same channel are merged into one; commands like /model and /restart and the \"limits\" question are answered directly without waking the orchestrator. Replies go back to the channel that asked; while the work runs the owner sees 👀, typing and, after ${after}, one progress message edited in place, and the answer goes out only when it is complete. Messages left unanswered at a restart are handled again.`,
				merge: "Merge window", mergeValue: (ms: number, max: string) => `${ms}ms (up to ${max})`, direct: "Answered directly", directValue: `/commands, "limits"`,
				route: "Reply route", routeValue: "The channel the question came from (Discord, web, terminal)", restart: "Restart", restartValue: (wait: string) => `After all work is done, restarts with the new code (a notice if the wait passes ${wait})`,
			},
			orchestrator: {
				label: (name: string) => `Orchestrator (${name})`,
				desc: (h: string, retries: number, restarts: number, window: string) => `The always-on assistant that receives every message (one ${h} conversation). It does light work itself and hands longer work to projects and sessions. When a usage limit hits, it holds messages and handles them in order right after the reset; server errors are retried up to ${retries} times. If it dies it is restarted automatically (up to ${restarts} times in ${window}), and when the conversation grows long it moves to a new conversation with a handover.`,
				context: "Context", resumes: "Resumes at", cache: "Cache keep-alive", cacheValue: (from: number, to: number, max: number) => `One ping at ${from}-${to} minutes while idle (up to ${max})`, cacheNa: "Not applicable (this runtime does not use it)",
				startPrompt: "Start prompt", startPromptValue: "Behaviour rules + identity + my rules + lessons + work-channel summary",
			},
			mode: {
				label: "Behaviour rules (MODE)", summary: (file: string) => `${file} · read-only`,
				desc: "The base contract that decides how the orchestrator and sessions work. It ships with the repository, so it is read-only here.",
				file: "File in use", language: "Language",
			},
			identity: {
				label: "Identity", summary: (name: string, language: string) => `Name ${name} · reply language ${language}`,
				desc: "Name, character and tone. If IDENTITY.md exists its content goes into the start prompt, otherwise the character and tone from settings do. The reply language is also the reference for the output-language check.",
			},
			rules: {
				label: "My rules (RULES)", summary: (n: number) => `Rules file · blocked commands: ${n}`,
				desc: "The standing rules and prohibitions I set. They take precedence over the behaviour rules and sessions read them too. Lines under \"Blocked commands\" are blocked before the orchestrator, sessions and subagents run them.",
				blocked: "Blocked commands",
			},
			lessons: {
				label: "Lessons (LESSONS)", summary: "Notes built by the nightly review",
				desc: "Notes the orchestrator tidies itself in the nightly review. My rules always win. You can edit or delete them.",
			},
			lanes: {
				label: "Sessions", summary: (n: number, working: number, max: number) => `${n} · ${working} working · up to ${max} at once`, none: (max: number) => `None · up to ${max} at once`,
				desc: (restarts: number, window: string) => `Independent jobs that take on small and medium work, one goal each (one session per channel). In a git repository each session works in its own worktree and branch, so my working folder is untouched, and it is cleaned up once merged. Each start applies the subagent model and the auto-compaction threshold. A stopped session is restarted automatically (up to ${restarts} times in ${window}).`,
				lanes: "Sessions", lanesValue: (n: number, working: number) => `${n} (${working} working)`, workDir: "Work folder", workDirValue: "In a git repository, a worktree just for the session",
				compaction: "Compaction", compactionValue: (tokens: string) => `Automatic at ${tokens} tokens of context`,
			},
			workers: {
				label: "Subagents", running: (n: number) => ` · ${n} running`,
				desc: "Hands that sessions split implementation, testing and exploration across. A session plans and reviews with its own model while subagents run in parallel on a cheaper one. How writing subagents are isolated is under Isolation.",
				kinds: "Kinds", kindsValue: (omo: boolean) => (omo ? "task categories (implement, test), explore and librarian (look up)" : "task (implement, test, render), scout (explore)"), limit: "Concurrency limit", limitValue: (n: number) => `${n} per session (based on this computer's specs)`,
				runningFact: "Running", isolation: "Isolation", isolationValue: (on: boolean) => (on ? "Writing subagents: isolated copy + patch applied after review (in place outside a git repository)" : "Not enforced (the work guard is off)"),
				expensive: "Expensive model", expensiveValue: (models: string) => `${models} only when I ask for it myself`,
			},
			outlang: {
				label: "Output language check", summary: (language: string) => `Rewritten and sent if not in ${language}`,
				desc: "If text going to me differs from the identity language (e.g. leaked while thinking in English), it is translated with one call to a small model. Language detection is local, so it is free, and if it fails the original goes out as is.",
				reference: "Reference language",
			},
			update: {
				label: "Harness update", install: "automatic install", check: "new versions only", na: (h: string) => `Not applicable · the runtime is ${h}`,
				desc: "Checks nightly whether the harness (OmO or omp) has a new version. With 'automatic install' (the default) it installs and restarts the gateway when everything is idle; 'new versions only' just tells the work-log channel.",
			},
			audit: {
				label: "Token usage audit",
				desc: "Scans OmO and omp conversation records daily for waste, such as a cache that broke for no reason or a conversation with an abnormally large context. If something is off, it tells the alert channel.",
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
				desc: (hours: number, margin: number, est: number) => `Login/keys and usage for model providers (Anthropic etc.). Before starting a session it looks at the ${hours}-hour limit and asks first if less than ${margin}% would remain after this work's share (default ${est}%). The weekly limit is shown only.`,
				used: "Providers in use", remaining: (pct: number) => `${pct}% left`,
			},
			hygiene: {
				label: "Session nightly cleanup", summary: (when: string) => `${when} · compact and rotate long sessions`,
				desc: (every: string) => `At a set time each day it checks idle sessions: if the conversation file is big it moves to a new conversation (handover), and if the context is big it compacts. Sessions that were working are left alone. It also deletes leftover temporary folders of finished subagents every ${every}.`,
			},
			memguard: {
				label: "Memory guard", summary: (gb: number) => `Restarts above ${gb} GB per process`,
				desc: (every: string, max: number, window: string) => `Every ${every} it checks the memory of the orchestrator and session processes and restarts them on the same conversation when over the limit (it stops a stray grep from eating tens of GB). If that happens more than ${max} times in ${window} it only sends an alert and stops.`,
			},
			guard: {
				label: (h: string) => `Work guard (${h})`, summary: "Checks briefs, patches, budget and external commands", missing: "Not loaded",
				desc: (h: string, file: string) => `The subagent guard ${h} loads (${file}). It enforces the rules below when a subagent is called and while it runs. Read-only here.`,
				expensiveOff: "Off (config.json guard.ask_before_expensive is not on)",
				installed: "Installed", notInstalled: "Not installed (the rules are not enforced)",
				briefing: "Briefing", briefingValue: (chars: number, lines: number, answer: number) => `Done-when required · ${chars}-character and ${lines}-line code limits · answers within ${answer} characters`,
				patch: "Patches", patchValue: "Writing subagents isolated + patch must be read before it can be applied",
				budget: "Budget", budgetValue: (hours: number, margin: number) => `Blocks and asks permission if under ${margin}% of the ${hours}-hour limit would remain`, budgetOff: "Off (config.json guard.budget_gate)",
				expensive: "Expensive model", expensiveValue: (models: string) => `${models} only when I ask`,
				external: "External commands", externalValue: "Subagents cannot push, deploy, ssh or send externally, and hand them back",
				context: "Context", contextValue: (wrap: number, stop: number) => `Subagent compaction no. ${wrap}: nudge to wrap up, no. ${stop}: block tools`,
				blocked: "Blocked commands in my rules",
			},
		},
		edges: {
			discord: "Message", web: "Chat", terminal: "Terminal input", schedule: "Scheduled time", watch: "Change detected", mail: "New mail and events",
			batch: "Passed on merged", delegate: "Delegate work", parallel: "Parallel run", mode: "Behaviour rules", identity: "Name and tone", rules: "My rules", rulesLanes: "Sessions read it too",
			lessons: "Lessons", lessonsWrite: "Write lessons", snapshot: "Snapshot", review: "Review request", outlang: "Reply language check", update: "New version notice", audit: "Waste alert",
			providers: "Model and limits", budget: "Budget gate", hygiene: "Nightly cleanup", memguard: "Memory monitoring", guard: "Enforce rules",
		},
		// The per-project maps (hub/harnessprojects.ts): one lane tied to a work or home channel.
		project: {
			channelKind: { work: "Work channel", home: "Home channel", thread: "Session thread" } as Record<string, string>,
			edgeIn: "Message", edgeFiles: "Read as instructions", edgeFeatures: "Applies here",
			globalNote: "This is a global setting. Change it on the main map; it is not set per project.",
			fallbackStep: (model: string, when?: string, cap?: string, revert?: string) => `${model}${when ? ` when ${when}` : ""}${cap ? ` · cap ${cap}` : ""}${revert ? ` · revert ${revert}` : ""}`,
			channel: {
				summary: (kind: string, purpose: string) => (purpose ? `${kind} · ${purpose}` : kind),
				desc: "A channel this project's session answers in. Messages written here reach the session's project with this channel's context.",
				kind: "Kind", purpose: "Purpose", logins: "Kept logins", monitors: "Monitors", standing: "Standing behaviour", updated: "Setup updated", noSetup: "No setup for this channel yet",
			},
			lane: {
				label: (name: string) => `Session ${name}`,
				desc: "The session that works on this project. Its model, effort and runtime can differ from the global session defaults; the settings below show which ones do.",
				state: "State", cwd: "Folder", repo: "Repository", thread: "Thread", runtime: "Runtime", fallback: "Fallback chain", none: "None",
			},
			workers: {
				label: (name: string) => `Subagents (${name})`,
				desc: "The task subagents this session starts. Their model and effort can differ from the global subagent defaults.",
				fallback: "Fallback chain", model: "Model", effort: "Effort",
			},
			files: { desc: "A project instruction file found in the session's folder. Only its name, size, modified time and first heading are shown.", size: "Size", modified: "Last modified", heading: "First heading", bytes: (n: string) => `${n} bytes`, folder: "Folder" },
			features: {
				label: "Project features", summary: (n: number) => `${n} item${n === 1 ? "" : "s"}`, none: "Nothing project-only found",
				desc: "Skills kept in the project folder and monitoring tied to this project's channels. They apply only here.",
				skill: "Skill", watch: "Monitoring", watchValue: (every: number, on: string) => `every ${every} min · on ${on}`,
			},
			deny: { label: "Project blocked commands", summary: (n: number) => `${n} line${n === 1 ? "" : "s"}`, desc: "'- deny:' lines under '## Blocked commands' in the project's instruction files. They are written for this project only." },
			settings: {
				model: { label: "Session model", hint: "Applies at once; a running session restarts on the new model" },
				effort: { label: "Session effort" },
				workerModel: { label: "Subagent model", hint: "Applies to subagents this session starts next" },
				workerEffort: { label: "Subagent effort" },
				runtime: { label: "Runtime", hint: "Applies the next time the session starts" },
			},
		},
	},
};
export type Catalog = typeof en;
