// Lane report, progress and notice handlers: how a session's text reaches the orchestrator, the web chat and Discord. Split out of main.ts.
import { join } from "node:path";
import { log, now, paths } from "./config.ts";
import * as discord from "./discord.ts";
import { msg } from "./i18n.ts";
import { emit, emitDelivery } from "./events.ts";
import { escalations } from "./escalate.ts";
import { lanes, sendToLane, setNoticeHandler as setLaneNoticeHandler, setOpenCardCheck, setOwnerNoteHandlers, setProgressHandler, setReportHandler, setVerifiedHandler } from "./lanes.ts";
import { decisionsOf, laneHasOpenCard, laneVerified } from "./notices.ts";
import { orch } from "./orchestrator.ts";
import { convs } from "./convsessions.ts";
import { createLaneRelay, ownerAlone } from "./lanerelay.ts";
import { workersOf } from "./lanevis.ts";
import { inOrder, localize, noteHandoffLeak } from "./outlang.ts";
import { parkedTone, parseTone, stripHandoff } from "./tone.ts";
import { send, deliver, onConvIdle, out, queue } from "./outbound.ts";
import { MAIN, primaryTarget } from "./session-key.ts";
import { dropForLine, forLines, waitsOnMain } from "./forline.ts";
import { recordHanded } from "./handed.ts";
import type { Lane } from "./lanestate.ts";
import { useKeptHooks } from "./agent-tree.ts";
import { clipKeepingAsk, normalizeAsk, plainBareAsk } from "./ask-normalize.ts";
import { withDoneLive } from "./done-live-wire.ts";
import { activeFleetLaunch } from "./fleet-launch.ts";

// A gateway note or a report for a session: main, a conversation session, or a lane (a stronger-model step reports to the lane that
// asked for it, hub/escalate.ts; sendToLane steers it into a running turn). A lane that cannot take it any more passes it to main.
export function deliverToSession(key: string, text: string): void {
	if (!key.startsWith("lane:")) return void (key === MAIN ? deliver(text) : convs.deliverTo(key, text, { target: primaryTarget(key) }));
	try {
		sendToLane(key.slice(5), text, undefined, true);
	} catch (e) {
		log(`${key} could not take a report (${(e as Error).message}); it goes to main`);
		deliver(text);
	}
}

// Steers a lane's report into the running turn of its session (`steerOf` finds that session's steer); false leaves the report to the
// relay, which holds it for the session's idle point (hub/lanerelay.ts flush). Main's turn is never steered: it multiplexes every
// conversation, and a report steered into it made it drop the work it was doing (39 such steers 2026-11-06..13; 2026-11-07T06:49Z).
export const reportSteer =
	(steerOf: (key: string) => ((note: string) => boolean) | undefined) =>
	(text: string, key: string): boolean =>
		key !== MAIN && (steerOf(key)?.(msg().laneReportSteer(text)) ?? false);

// A lane started from a conversation session (or from a lane) reports to that session (its key is the lane's `from`); the rest report to main.
export const laneRelay = createLaneRelay({
	busy: key => !key.startsWith("lane:") && (key === MAIN ? orch : convs.get(key)?.o.orch)?.status === "working",
	deliver: (text, key) => deliverToSession(key, text),
	lead: n => msg().inboxLaneReports(n),
	steer: reportSteer(key => convs.get(key)?.o.steer),
});

// A [wait] on main from a lane main started is main's handed work from that lane, the queue entry its dotz_main request makes
// (hub/routes-send.ts): main's answer goes back to the lane (hub/prompts.ts handBack). Relayed as a plain report, the answer went to
// main's own channel and the lane heard nothing until the owner pushed (review-a G9). Not in the turn that answers main's own answer
// (one round, as dotz_main refuses it); the same wait again is dropped, as the relay drops a repeat. Undefined: not such a wait.
const handedWaits = new Map<string, string>();
export function handWaitToMain(lane: Pick<Lane, "name" | "from">, text: string, answeringMain: boolean): "relayed" | "duplicate" | undefined {
	if (answeringMain || (lane.from ?? MAIN) !== MAIN || parseTone(text).tone !== "wait" || !waitsOnMain(text)) return void handedWaits.delete(lane.name);
	const key = text.replace(/\s+/g, " ").trim();
	if (handedWaits.get(lane.name) === key) return "duplicate";
	handedWaits.set(lane.name, key);
	const from = `lane:${lane.name}`;
	recordHanded({ to: primaryTarget(MAIN), from, text });
	queue.deliver(`[${from}] ${text}`, { target: from, from });
	return "relayed";
}

// Why this orchestrator post may not go out, when it would ask a session's open question a second time. A session's [ask] is already in 답변 필요 and the owner's answer
// there reaches the session, so the turn that heard it makes no card of its own, in any words (2026-11-05 publish-voice: two cards 9 s apart; the same
// on 2026-11-04 for web-onboarding, cloudflare-webapp and code-health, each a dotz_send). The card is what the post would make, read as the notices read
// it; a send approval is its own card. Nothing is read unless this turn heard a question.
export function repostRefusal(target: string, text: string): string | undefined {
	const open = laneRelay.asked().filter(name => laneHasOpenCard(name) || lanes.get(name)?.pendingAsk);
	if (!open.length) return undefined;
	const cards = decisionsOf({ ts: now(), kind: "out", source: "orchestrator", target, text: normalizeAsk(stripHandoff(text)) });
	if (!cards.some(c => !c.draft)) return undefined;
	log(`orchestrator post to ${target} refused: it repeats the open question of ${open.join(", ")}`);
	return msg().laneAskWaiting(open.join(", "));
}

export function installLaneHandlers(): void {
	onConvIdle(key => void laneRelay.flush(key));
	setVerifiedHandler((name, text) => laneVerified(name, text));
	setOpenCardCheck(laneHasOpenCard);
	setReportHandler((lane, raw, answering, pause) => {
		noteHandoffLeak(`lane:${lane.name}`, raw);
		const answeringMain = lane.handedBack === true;
		lane.handedBack = undefined;
		const text = stripHandoff(raw);
		activeFleetLaunch()?.report(lane, text);
		const handed = handWaitToMain(lane, text, answeringMain);
		if (handed === "relayed") log(`lane ${lane.name} [wait] on main handed to main as its request; the answer goes back to the lane`);
		const how = handed ?? laneRelay.report(lane.name, raw, join(paths.lanes, lane.name, "report.md"), ownerAlone(lane, pause === true, workersOf(`lane:${lane.name}`).length), lane.from);
		if (how === "relayed" || how === "held" || how === "steered") lane.orchAsked = false;
		if (escalations()?.reported(lane.name, parseTone(text).tone)) log(`lane ${lane.name} ended: its stronger-model step reported back`);
		if (how === "steered") log(`lane ${lane.name} report steered into the orchestrator's turn`);
		else if (how === "relayed") log(`lane ${lane.name} report relayed to the orchestrator`);
		else if (how !== "held") log(`lane ${lane.name} report ${how === "disk" ? "kept on disk (routine progress)" : how === "owner" ? "kept on disk (answer to the owner in the lane channel)" : "dropped (same as the last one)"}`);
		if (how === "held") log(`lane ${lane.name} report held for the orchestrator's next idle point`);
		const channel = `lane:${lane.name}`;
		// A [run] or [wait] report is progress: it edits the lane's one progress message (on the web the newest one takes the older one's place, chatPush). Results, questions and failures are real messages.
		// A [run] text that is the answer to an owner message is that answer, not progress to edit away.
		const running = parkedTone(parseTone(text).tone) && !answering;
		// The owner-visible part is localized once, before it is recorded: the web chat, the bell, push and Discord all show that
		// text (the web showed a lane's English report while only Discord got the rewrite). The orchestrator and report.md keep
		// the raw report, and the "For <bot>:" line stays as written (notices.ts reads it).
		const body = dropForLine(text);
		void inOrder(channel, async () => {
			const local = await localize(body, channel, "lane");
			const kept = local === body ? text : [local, forLines(text)].filter(Boolean).join("\n\n");
			// `answering`: the report answers an owner message (the bell and push treat it as the session's answer, hub/notices.ts, hub/push.ts).
			// An ask's event carries the ask's own time: the docked card (pendingAsk) and the decision notice (this event) must name one message, or an answer on one leaves the other open (pilot-stage1 2026-11-05: tapped twice, 2 ms apart).
			const ts = lane.pendingAsk?.text === text ? lane.pendingAsk.at : now();
			emit("inbox", { ts, kind: "lane_report", source: channel, lane: lane.name, text: kept, ...(answering ? { answering: true } : {}) });
			return clipKeepingAsk(local, 1800);
		})
			.then(async shown => {
				if (running) return void (await discord.progress(channel, "progress", shown));
				if ((await send(channel, shown)).delivered) await discord.clearProgress(channel);
			})
			.catch(e => log(`lane report send failed: ${e}`));
	});

	// A session's short answer to an owner message, said before a tool call mid-turn (the footer asks for it): a real message in the
	// session's chat and Discord channel at once, with the progress line it replaces cleared; the owner's messages become "answered".
	setOwnerNoteHandlers({
		note: (lane, raw, refs) => {
			noteHandoffLeak(`lane:${lane}`, raw);
			const channel = `lane:${lane}`;
			void inOrder(channel, async () => {
				const shown = await localize(clipKeepingAsk(dropForLine(plainBareAsk(normalizeAsk(stripHandoff(raw)))), 900), channel, "lane");
				emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown, answers: refs });
				return shown;
			})
				.then(shown => send(channel, shown))
				.then(r => (r.delivered ? discord.clearProgress(channel) : undefined))
				.catch(e => log(`lane answer note failed: ${e}`));
		},
		answered: (lane, refs) => refs.forEach(ref => emitDelivery(`lane:${lane}`, ref, "answered")),
		refused: (lane, refs) => refs.forEach(ref => emitDelivery(`lane:${lane}`, ref, "failed", "세션이 이 메시지를 따르지 않았어요. 다시 보내 주세요")),
		lost: (lane, refs) => refs.forEach(ref => emitDelivery(`lane:${lane}`, ref, "failed", "세션이 끝났어요")),
	});

	// Mid-turn lane text: an [ask], [fail] or [done] line is something the owner must see and keep, so it is a real message;
	// anything else edits the lane channel's one progress message.
	setProgressHandler((lane, raw) => {
		const text = withDoneLive(plainBareAsk(normalizeAsk(stripHandoff(raw))));
		const channel = `lane:${lane.name}`;
		const tone = parseTone(text).tone;
		const real = tone === "ask" || tone === "fail" || tone === "done";
		void inOrder(channel, async () => {
			const clipped = clipKeepingAsk(dropForLine(text), real ? 1800 : 900);
			const row = (t: string) => {
				const shown = real || parkedTone(tone) ? t : `[run] ${t}`;
				emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown, ...(real ? {} : { update_key: "progress" }) });
				return shown;
			};
			// A progress line is replaced by the next one on the web: the original shows at once and its rewrite takes its place.
			let first: string | undefined;
			const local = await localize(clipped, channel, "lane", real ? undefined : t => void (first = row(t)));
			return first !== undefined && local === clipped ? first : row(local);
		})
			.then(shown => (real ? send(channel, shown) : discord.progress(channel, "progress", shown)))
			.catch(e => log(`lane progress send failed: ${e}`));
	});

	// A model fallback of a lane (and its task workers) is one plain line in the lane's channel, the orchestrator's task workers' one in worklog (the orchestrator's own goes to the alert channel). None wakes the orchestrator.
	convs.everyInstance(c => c.o.setNoticeHandler(text => void out(discord.status.enabled ? "worklog" : "web", text, undefined, { source: "gateway" }).catch(e => log(`model fallback notice failed: ${e}`))));
	const laneLine = (channel: string, text: string): void => {
		void inOrder(channel, async () => {
			const shown = await localize(text, channel, "lane");
			emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown });
			return shown;
		})
			.then(shown => send(channel, shown))
			.catch(e => log(`lane model fallback notice failed: ${e}`));
	};
	setLaneNoticeHandler((lane, text) => laneLine(`lane:${lane.name}`, text));
	// A kept process (hub/agent-tree.ts) that ends is one plain line in its session's channel; a stopped or deleted session ends them.
	useKeptHooks({
		say: (owner, text) => {
			if (owner.startsWith("lane:")) return laneLine(owner, text);
			const target = convs.get(owner)?.primary ?? (discord.status.enabled ? "worklog" : "web");
			void out(target, text, undefined, { source: "gateway" }).catch(e => log(`kept process notice failed: ${e}`));
		},
		ended: owner => {
			if (owner.startsWith("lane:")) {
				const lane = lanes.get(owner.slice(5));
				return !lane || (lane.ownerStopped === true && !lane.proc);
			}
			const c = convs.get(owner);
			return !c || (c.o.orch.stoppedBy === "owner" && c.o.orchestratorPid() === undefined);
		},
	});
}
