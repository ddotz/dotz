import { expect, test } from "bun:test";
import { guardLine, guardTarget } from "./conv-guard.ts";
import { sessionKeyOf } from "./session-key.ts";

const keyOf = (target: string | undefined) => sessionKeyOf(target, { on: true });

test("a post in the session's own conversation is unchanged", () => {
	expect(guardTarget("main", "web", keyOf)).toEqual({ target: "web" });
	expect(guardTarget("ch:7", "ch:7", keyOf)).toEqual({ target: "ch:7" });
	expect(guardTarget("alert", "web:alert", keyOf, "dotz_send")).toEqual({ target: "web:alert" });
});

test("another conversation with a named reason is kept and reported with the reason", () => {
	const g = guardTarget("main", "ch:7", keyOf, "dotz_send");
	expect(g).toEqual({ target: "ch:7", crossed: "dotz_send" });
	expect(guardLine("main", "ch:7", g)).toBe("cross-conversation post: main -> ch:7 (dotz_send)");
	expect(guardTarget("main", "mail:k1", keyOf, "approval")).toEqual({ target: "mail:k1", crossed: "approval" });
});

test("another conversation without a reason is posted in the session's own conversation, and the line says where", () => {
	const g = guardTarget("main", "ch:7", keyOf);
	expect(g).toEqual({ target: "web", refused: true });
	expect(guardLine("main", "ch:7", g)).toBe("cross-conversation post refused: main -> ch:7; posted in web");
	expect(guardTarget("ch:7", "web", keyOf)).toEqual({ target: "ch:7", refused: true });
	expect(guardLine("ch:7", "web", { target: "web" })).toBeUndefined();
});
