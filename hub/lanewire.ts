// Lane report, progress and notice handlers: how a session's text reaches the orchestrator, the web chat and Discord. Split out of main.ts.
import { join } from "node:path";
import { log, now, paths } from "./config.ts";
import * as discord from "./discord.ts";
import { msg } from "./i18n.ts";
import { emit, emitDelivery } from "./events.ts";
import { setNoticeHandler as setLaneNoticeHandler, setOpenCardCheck, setOwnerNoteHandlers, setProgressHandler, setReportHandler, setVerifiedHandler } from "./lanes.ts";
import { laneHasOpenCard, laneVerified } from "./notices.ts";
import { orch, steer as steerOrchestrator } from "./orchestrator.ts";
import { convs } from "./convsessions.ts";
import { createLaneRelay } from "./lanerelay.ts";
import { inOrder, localize, noteHandoffLeak } from "./outlang.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import { send, deliver, out } from "./outbound.ts";
import { dropForLine, forLines } from "./forline.ts";
import { clipKeepingAsk, normalizeAsk, plainBareAsk } from "./ask-normalize.ts";

export const laneRelay = createLaneRelay({ busy: () => orch.status === "working", deliver: text => deliver(text), lead: n => msg().inboxLaneReports(n), steer: text => steerOrchestrator(msg().laneReportSteer(text)) });

export function installLaneHandlers(): void {
	setVerifiedHandler((name, text) => laneVerified(name, text));
	setOpenCardCheck(laneHasOpenCard);
	setReportHandler((lane, raw, answering) => {
		noteHandoffLeak(`lane:${lane.name}`, raw);
		const text = stripHandoff(raw);
		const how = laneRelay.report(lane.name, raw, join(paths.lanes, lane.name, "report.md"), lane.orchAsked === false);
		if (how === "relayed" || how === "held" || how === "steered") lane.orchAsked = false;
		if (how === "steered") log(`lane ${lane.name} report steered into the orchestrator's turn`);
		else if (how === "relayed") log(`lane ${lane.name} report relayed to the orchestrator`);
		else if (how !== "held") log(`lane ${lane.name} report ${how === "disk" ? "kept on disk (routine progress)" : how === "owner" ? "kept on disk (answer to the owner in the lane channel)" : "dropped (same as the last one)"}`);
		if (how === "held") log(`lane ${lane.name} report held for the orchestrator's next idle point`);
		const channel = `lane:${lane.name}`;
		// A [run] report is progress: it edits the lane's one progress message. Results, questions and failures are real messages.
		// A [run] text that is the answer to an owner message is that answer, not progress to edit away.
		const running = parseTone(text).tone === "run" && !answering;
		// The owner-visible part is localized once, before it is recorded: the web chat, the bell, push and Discord all show that
		// text (the web showed a lane's English report while only Discord got the rewrite). The orchestrator and report.md keep
		// the raw report, and the "For <bot>:" line stays as written (notices.ts reads it).
		const body = dropForLine(text);
		void inOrder(channel, async () => {
			const local = await localize(body, channel, "lane");
			const kept = local === body ? text : [local, forLines(text)].filter(Boolean).join("\n\n");
			// `answering`: the report answers an owner message (the bell and push treat it as the session's answer, hub/notices.ts, hub/push.ts).
			emit("inbox", { ts: now(), kind: "lane_report", source: channel, lane: lane.name, text: kept, ...(answering ? { answering: true } : {}) });
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
		const text = plainBareAsk(normalizeAsk(stripHandoff(raw)));
		const channel = `lane:${lane.name}`;
		const tone = parseTone(text).tone;
		const real = tone === "ask" || tone === "fail" || tone === "done";
		void inOrder(channel, async () => {
			const local = await localize(clipKeepingAsk(dropForLine(text), real ? 1800 : 900), channel, "lane");
			const shown = real || tone === "run" ? local : `[run] ${local}`;
			emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown, ...(real ? {} : { update_key: "progress" }) });
			return shown;
		})
			.then(shown => (real ? send(channel, shown) : discord.progress(channel, "progress", shown)))
			.catch(e => log(`lane progress send failed: ${e}`));
	});

	// A model fallback of a lane (and its task workers) is one plain line in the lane's channel, the orchestrator's task workers' one in worklog (the orchestrator's own goes to the alert channel). None wakes the orchestrator.
	convs.everyInstance(c => c.o.setNoticeHandler(text => void out(discord.status.enabled ? "worklog" : "web", text, undefined, { source: "gateway" }).catch(e => log(`model fallback notice failed: ${e}`))));
	setLaneNoticeHandler((lane, text) => {
		const channel = `lane:${lane.name}`;
		void inOrder(channel, async () => {
			const shown = await localize(text, channel, "lane");
			emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown });
			return shown;
		})
			.then(shown => send(channel, shown))
			.catch(e => log(`lane model fallback notice failed: ${e}`));
	});
}
