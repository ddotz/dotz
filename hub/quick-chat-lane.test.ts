// A session launch asked for by the quick chat (session "quick") is refused at the gateway route.
import { expect, test } from "bun:test";
import { routeLanes } from "./routes-lanes.ts";

test("a lane launch from the quick chat answers 403", async () => {
	const url = new URL("http://hub/api/lanes");
	const body = { name: "quick-lane-check", session: "quick", brief: "x" };
	const res = await routeLanes(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, ["api", "lanes"]);
	expect(res!.status).toBe(403);
});
