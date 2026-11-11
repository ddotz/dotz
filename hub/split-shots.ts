// Screenshot scenarios of the split panes (web/js/43-panes*.js) on the demo page, for the shot tool of the split-panes lane (bun <tool> <root> <out> <prefix>).
import type { View } from "./layout-measure.ts";

type Lm = typeof import("./layout-measure.ts");
export type SplitShot = { name: string; widths: number[]; run: (view: View, lm: Lm) => Promise<void> };

const LANE = "lane:랜딩-점검";

// Splits the active pane (or the pane at index `at` of paneList()) and waits until the new pane is drawn.
async function split(view: View, lm: Lm, n: number, t: string, kind: string, side: string, at = -1): Promise<void> {
	if (at >= 0) await view.evaluate(`paneFocus(paneList()[${at}].id)`);
	await view.evaluate(`paneSplit(${JSON.stringify(t)}, ${JSON.stringify(kind)}, ${JSON.stringify(side)})`);
	await lm.waitFor(view, `paneCount() === ${n} && document.querySelectorAll("#split .pane").length === ${n} && document.querySelector("#split .pane.on")`);
}
const open = (view: View, lm: Lm) => lm.goScreen(view, "chat-open");

// Pulls a running session's row over the right edge of the one conversation and stops before the drop, so the zone overlay is on screen.
async function dragOverEdge(view: View, lm: Lm): Promise<void> {
	await open(view, lm);
	await view.evaluate(`(() => {
		const row = document.querySelector('#chat-convo .cv-row[data-t^="lane:"]'), r = row.getBoundingClientRect(), c = document.getElementById("cv-head").getBoundingClientRect(), b = document.getElementById("composer").getBoundingClientRect();
		const fire = (type, x, y) => document.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
		row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10, pointerId: 1, button: 0 }));
		fire("pointermove", r.left + 40, r.top + 20);
		fire("pointermove", c.right - 40, (c.top + b.bottom) / 2);
	})()`);
	await lm.waitFor(view, `!!document.querySelector(".pn-zone") && !!document.querySelector(".pn-ghost")`);
}

export const SPLIT_SHOTS: SplitShot[] = [
	{ name: "drag", widths: [1280], run: dragOverEdge },
	{ name: "two", widths: [1280, 1600], run: async (view, lm) => {
		await open(view, lm);
		await split(view, lm, 2, LANE, "chat", "right");
	} },
];
