import { expect, test } from "bun:test";
import { stuckHovers } from "./hover-touch-css.ts";

// The reader behind `bun hub/check.ts` (hub/hover-touch-css.ts) must see a bare :hover rule as stuck and leave the mouse-only and taken-back ones alone.
test("a :hover look rule outside @media (hover: hover) is stuck; a mouse-only one, one a touch block takes back and a non-look one are not", () => {
	const css = `
		.a:hover { background: red; }
		@media (hover: hover) { .b:hover { color: red; } }
		.c:hover { opacity: .5; }
		@media (hover: none) { .c:hover { opacity: 1; } }
		.d:hover { cursor: pointer; }
		/* .e:hover { color: red; } in a comment */
	`;
	expect(stuckHovers(css)).toEqual({ stuck: [".a:hover"], mouseOnly: 1 });
});
