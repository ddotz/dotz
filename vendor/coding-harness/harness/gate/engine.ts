import { whereis } from "../checkouts/place.ts";
import { folderWrites, slotCall } from "../checkouts/redirect.ts";
import { acceptedTextAt } from "./accepted-gate.ts";
import { sessionFiles } from "./changed.ts";
import { handlerDeadline, until } from "./deadline.ts";
import { createFeedback } from "./feedback.ts";
import type { BaseOf, FeedbackBase, RunFeedback } from "./feedback.ts";
import { cwdOf, inDotz, isMain, sessionIdOfFile, sessionKey } from "./host.ts";
import type { Ctx, GateHandlers, SessionChangeEvent, ToolResultContext } from "./host.ts";
import { cancelLater, judging, noteRun, reportSettled } from "./later.ts";
import type { Deliver } from "./later.ts";
import type { Show } from "./show-report.ts";
import { inheritMistakes } from "./mistakes.ts";
import { afterBash, afterCommand, afterPatch, beforeBash, beforeCommand, beforePatch, markEdited, saveHidden } from "./moves.ts";
import { appliesPatch, delegatesWrites, evidenceCall } from "./ran.ts";
import { filesByRepo } from "./repo-files.ts";
import { askedScriptOf, isProtocolAnswer, LANGUAGE_NAMES, promptScriptOf, scriptOf } from "./report.ts";
import { beginRun, changesOf, endCall, endRun, forgetRepo, isSourceFile, newState, noteEvidence, noteSourceWrite, startCall, track, userScriptOf } from "./session.ts";
import type { SessionChange, State } from "./session.ts";
import { baseRef } from "./snapshot.ts";
import { realStages } from "./stages.ts";
import type { Stages } from "./stages.ts";
import { onStop } from "./stop.ts";
import { forgetReplies, noteReply, toggleSuperseded } from "./superseded.ts";
import { bashDirs, editedPaths, skillFilesRead, touchedPaths } from "./tool-paths.ts";
import { isRecord, message, replyText } from "./util.ts";

const SESSION_CHANGES_BUDGET_MS = 20_000;
const SYSTEM_PROMPT = /^\s*(?:<system|done-gate:|session-restart:|\[peer message from )/;
const ULW_NUDGE =
	"done-gate: this session hands source writes to a worker, applies a patch, or edits more than three source files, and has not read skill://ulw. The router (rules/routines.md) reads skill://ulw and the playbook it picks first for HEAVY work: an auth, security, schema, concurrency or external-integration fact, more than three files, an unattended or multi-step run, or the keyword ulw. Read them now before going on.";
const ULW_SOURCE_FILES = 3;
const OVNFS_LAND = /(?:^|[\s;&|(])ovnfs\s+land\b([^;&|\n]*)/g;

function ownSlotLanded(cwd: string, input: Record<string, unknown>): string | undefined {
	const landings = typeof input.command === "string" ? [...input.command.matchAll(OVNFS_LAND)] : [];
	if (landings.length === 0) return undefined;
	const slot = whereis(cwd);
	if (slot === undefined) return undefined;
	return landings.every(landing => landing[1].split(/\s+/).includes(slot.name)) ? slot.folder : undefined;
}

const SLOT_CALLS_KEPT = 1000;
type SlotCalls = Map<string, Record<string, unknown> | "refused">;
const slotCallsOf = new WeakMap<State, SlotCalls>();

function slotCallsFor(state: State): SlotCalls {
	const known = slotCallsOf.get(state);
	if (known !== undefined) return known;
	const made: SlotCalls = new Map();
	slotCallsOf.set(state, made);
	return made;
}

function slotInput(tool: string | undefined, input: Record<string, unknown>, ctx: Ctx): { readonly input: Record<string, unknown>; readonly moved: boolean; readonly refused: boolean } {
	const cwd = cwdOf(ctx);
	const slotted = slotCall(cwd, tool ?? "", input);
	const revised = isRecord(slotted.input) ? slotted.input : input;
	const refused = slotted.placement !== undefined && folderWrites(slotted.placement, tool ?? "", revised, cwd).length > 0;
	return { input: revised, moved: slotted.moved.length > 0, refused };
}

async function noteSourceWrites(state: State, paths: readonly string[], calls: number, signal: AbortSignal): Promise<void> {
	for (const [repo, files] of await filesByRepo(state.dirRepo, paths.filter(isSourceFile), signal)) {
		for (const file of files) noteSourceWrite(state, repo, file, calls);
	}
}

export interface DoneGate {
	handlers: GateHandlers;
	sessionChanges(ctx: Ctx, signal?: AbortSignal): Promise<SessionChange[]>;
	waive(ctx: Ctx, reason: string): boolean;
	toggleSuperseded(ctx: Ctx): void;
}

/** One done gate: the handlers a host registers, the per-session changes the mistake obligations read, and the user's waiver. All state lives in this closure, keyed by session id. `deliver` puts a check's failure that arrives after a stop before the agent; without it, a stop waits for running checks. `show` draws a multi-line notice as a block; without it, the notice goes through `ctx.ui.notify`. */
export function createDoneGate(stages: Stages = realStages, deliver?: Deliver, show?: Show): DoneGate {
	const sessions = new Map<string, State>();
	const feedback = createFeedback(stages);
	const stateOf = (ctx: Ctx): State => {
		const key = sessionKey(ctx);
		const known = sessions.get(key);
		if (known) return known;
		const created = newState();
		sessions.set(key, created);
		return created;
	};
	const free = (id: string): void => {
		const state = sessions.get(id);
		if (state !== undefined) {
			cancelLater(state);
			endRun(state);
			forgetReplies(state);
		}
		sessions.delete(id);
		feedback.reset(id);
	};
	const leave = (event: SessionChangeEvent, ctx: Ctx, inherits: boolean): void => {
		const left = sessionIdOfFile(event.previousSessionFile);
		const child = sessionKey(ctx);
		if (inherits && left !== undefined) inheritMistakes(left, child);
		free(left ?? child);
		for (const [id, state] of sessions) if (id !== child) cancelLater(state);
	};
	const mainBase =
		(state: State): BaseOf =>
		async (repo, signal) => {
			const baseline = state.baselines.get(repo);
			if (baseline === undefined || baseline.failure !== undefined) return undefined;
			const settled = await until(baseline.result, signal);
			if (!settled?.value.ok) return undefined;
			const start = settled.value.snapshot;
			const found: FeedbackBase = { base: baseRef(start), baseText: baseline.texts.textAt, toolEdited: baseline.toolEdited, acceptedText: acceptedTextAt(repo) };
			try {
				return { ...found, files: (await sessionFiles(repo, start, baseline, signal)).files };
			} catch {
				return found;
			}
		};

	const handlers: GateHandlers = {
		async before_agent_start(event, ctx) {
			if (!isMain(ctx) || event.reason !== "prompt") return;
			const state = stateOf(ctx);
			const continued = state.refusal !== undefined && event.prompt === state.refusal;
			state.next = continued ? "continue" : "fresh";
			if (continued || event.prompt === undefined || SYSTEM_PROMPT.test(event.prompt)) return;
			state.askedScript = askedScriptOf(event.prompt) ?? state.askedScript;
			state.userScript = promptScriptOf(event.prompt) ?? state.userScript;
			const written = scriptOf(event.prompt);
			if (written !== undefined && written !== "latin") state.firmScript = written;
		},
		async agent_start(_event, ctx) {
			if (!isMain(ctx)) return;
			const state = stateOf(ctx);
			const resumed = state.next === "continue" && state.active;
			state.next = undefined;
			if (!resumed) await beginRun(state, cwdOf(ctx), handlerDeadline());
			noteRun(state);
		},
		async agent_end(event, ctx) {
			if (!isMain(ctx)) return;
			const state = stateOf(ctx);
			state.next = event.willContinue === true ? "continue" : undefined;
			if (event.willContinue === true || !state.active) return;
			state.active = false;
			if (deliver !== undefined) reportSettled(state, ctx, deliver);
		},
		async assistant_message(event, ctx) {
			if (!isMain(ctx)) return undefined;
			const state = stateOf(ctx);
			const reply = replyText(event.message?.content);
			state.reply = reply;
			noteReply(state, event.message?.timestamp);
			const wrote = inDotz() || isProtocolAnswer(reply) ? undefined : scriptOf(reply);
			const user = userScriptOf(state);
			state.interimLanguage = wrote !== undefined && user !== undefined && wrote !== user ? wrote : undefined;
			return undefined;
		},
		async tool_call(event, ctx) {
			if (!isMain(ctx)) return undefined;
			const state = stateOf(ctx);
			const slotted = slotInput(event.toolName, event.input ?? {}, ctx);
			const input = slotted.input;
			if (event.toolCallId !== undefined && (slotted.moved || slotted.refused)) {
				const slotCalls = slotCallsFor(state);
				if (slotCalls.size >= SLOT_CALLS_KEPT) slotCalls.clear();
				slotCalls.set(event.toolCallId, slotted.refused ? "refused" : input);
			}
			if (slotted.refused) return undefined;
			startCall(state, event.toolCallId, input);
			let nudge: ToolResultContext | undefined;
			try {
				const cwd = cwdOf(ctx);
				const deadline = handlerDeadline();
				for (const ref of skillFilesRead(event.toolName, input)) {
					state.skills.add(ref.split("/", 1)[0]);
					state.skillFiles.add(ref);
				}
				const where = event.toolName === "bash" ? [cwd, ...bashDirs(input, cwd)] : [cwd];
				const edited = editedPaths(event.toolName, input, cwd);
				if (state.skills.has("ulw")) state.ulwRead = true;
				const delegates = delegatesWrites(event.toolName ?? "", input);
				if (delegates) state.delegated = true;
				for (const file of edited) if (isSourceFile(file)) state.sourcesEdited.add(file);
				if (!inDotz() && !state.nudgedUlw && !state.ulwRead && (delegates || state.sourcesEdited.size > ULW_SOURCE_FILES)) {
					state.nudgedUlw = true;
					nudge = { additionalContext: ULW_NUDGE };
				}
				const wrote = state.interimLanguage;
				const user = userScriptOf(state);
				if (wrote !== undefined && user !== undefined) {
					state.interimLanguage = undefined;
					state.interimWrong += 1;
					const name = LANGUAGE_NAMES[user];
					const told = `done-gate: your last message was written in ${LANGUAGE_NAMES[wrote]}, but the user writes in ${name}. Every message the user sees, interim notes between tool calls included, must be in ${name}; code, paths and commands stay as they are.`;
					nudge = { additionalContext: nudge === undefined ? told : `${nudge.additionalContext}\n${told}` };
				}
				const label = typeof input.i === "string" && !inDotz() ? scriptOf(input.i) : undefined;
				if (label !== undefined && user !== undefined && label !== user) {
					state.interimWrong += 1;
					const name = LANGUAGE_NAMES[user];
					const told = `done-gate: the intent label of this tool call ("${String(input.i).slice(0, 80)}") is in ${LANGUAGE_NAMES[label]}, but the user writes in ${name}. The user sees every intent label: write them in ${name}.`;
					nudge = { additionalContext: nudge === undefined ? told : `${nudge.additionalContext}\n${told}` };
				}
				await track(state, [{ paths: where, edited: false, bash: event.toolName === "bash" }, { paths: edited, edited: true }], deadline, true);
				if (event.toolName === "bash") await beforeBash(state, event.toolCallId, where, deadline);
				await saveHidden(state, edited, deadline);
				await markEdited(state, edited, deadline);
				if (appliesPatch(event.toolName ?? "", input)) await beforePatch(state, event.toolCallId, deadline);
				else if (event.toolName === "bash" && typeof input.command === "string") await beforeCommand(state, event.toolCallId, input.command, where, deadline);
			} catch (error) {
				state.errors.push(message(error));
			}
			return nudge;
		},
		async tool_result(event, ctx) {
			if (!isMain(ctx)) return undefined;
			const state = stateOf(ctx);
			const slotCalls = slotCallsFor(state);
			const slotted = event.toolCallId === undefined ? undefined : slotCalls.get(event.toolCallId);
			if (event.toolCallId !== undefined) slotCalls.delete(event.toolCallId);
			if (slotted === "refused") return undefined;
			const call = endCall(state, event.toolCallId);
			const input = slotted ?? event.input ?? call?.input ?? {};
			const calls = call?.calls ?? state.toolCalls;
			const run: RunFeedback = { state, patched: [], verifies: false };
			try {
				const ran = evidenceCall(event.toolName ?? "", input);
				if (ran) noteEvidence(state, calls);
				const deadline = handlerDeadline();
				run.patched = await afterPatch(state, event.toolCallId, calls, deadline);
				if (event.toolName === "bash") {
					await afterBash(state, event.toolCallId, input, event.details, deadline);
					await afterCommand(state, event.toolCallId, deadline);
					const landedOn = ownSlotLanded(cwdOf(ctx), input);
					if (landedOn !== undefined) forgetRepo(state, landedOn);
				} else {
					const touched = touchedPaths(event.toolName, input, event.details, cwdOf(ctx));
					await markEdited(state, touched, deadline);
					if (event.isError !== true) await noteSourceWrites(state, touched, calls, deadline);
				}
				const lastWrite = [...state.sourceWrites.values()].reduce((last, files) => [...files.values()].reduce((most, at) => Math.max(most, at), last), 0);
				run.verifies = ran && lastWrite > 0 && calls > lastWrite;
			} catch (error) {
				state.errors.push(message(error));
			}
			return await feedback.after(event, ctx, mainBase(state), run);
		},
		async session_stop(event, ctx) {
			if (!isMain(ctx)) return undefined;
			const state = stateOf(ctx);
			return await judging(state, () => onStop(state, ctx, event, stages, deliver, show));
		},
		async session_switch(event, ctx) {
			leave(event, ctx, event.reason === "fork");
		},
		async session_branch(event, ctx) {
			leave(event, ctx, true);
		},
		async session_shutdown(_event, ctx) {
			free(sessionKey(ctx));
		},
	};

	return {
		handlers,
		async sessionChanges(ctx, signal = AbortSignal.timeout(SESSION_CHANGES_BUDGET_MS)) {
			const state = isMain(ctx) ? sessions.get(sessionKey(ctx)) : undefined;
			return state ? await changesOf(state, signal) : [];
		},
		waive(ctx, reason) {
			if (!isMain(ctx)) return false;
			stateOf(ctx).waiver = { reason };
			return true;
		},
		toggleSuperseded(ctx) {
			toggleSuperseded(isMain(ctx) ? sessions.get(sessionKey(ctx)) : undefined, ctx);
		},
	};
}
