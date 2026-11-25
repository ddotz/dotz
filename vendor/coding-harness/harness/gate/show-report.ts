/** The transcript message of a report: shown to the user as a markdown block, never sent to the model and never starting a turn. */
export interface ReportMessage {
	customType: "harness-report";
	display: true;
	excludeFromContext: true;
	content: string;
}

/** The part of an extension API `showReport` needs. */
export interface ReportHost {
	sendMessage(message: ReportMessage): void;
}

/** The part of an extension context `showReport` needs. */
export interface ReportContext {
	mode?: string;
	ui?: { notify(text: string, level: "info" | "warning" | "error"): void };
}

/** A multi-line report: `markdown` is the body (may be empty), `title` the one-line summary. */
export interface Report {
	title: string;
	markdown: string;
	level: "info" | "warning" | "error";
}

/** Shows a report to the user of the session `ctx` belongs to; the host binds it to its extension API. */
export type Show = (ctx: ReportContext, report: Report) => void;

/** Shows `report` as a markdown block in the transcript of an interactive terminal; in every other mode it goes out as one `ctx.ui.notify` text, title first. */
export function showReport(pi: ReportHost, ctx: ReportContext, report: Report): void {
	if (ctx.mode === "tui") {
		const heading = `**${report.title}**`;
		pi.sendMessage({ customType: "harness-report", display: true, excludeFromContext: true, content: report.markdown === "" ? heading : `${heading}\n\n${report.markdown}` });
		return;
	}
	notifyReport(ctx, report);
}

/** Sends `report` as one `ctx.ui.notify` text at its level, title first; for hosts that cannot draw a block. */
export function notifyReport(ctx: ReportContext, report: Report): void {
	ctx.ui?.notify(report.markdown === "" ? report.title : `${report.title}\n${report.markdown}`, report.level);
}
