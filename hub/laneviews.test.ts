// GET /api/models builds its lane list with laneModels(); a missing import there once made the whole endpoint throw.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { modelsView } from "./control.ts";
import { lanesModel } from "./config.ts";
import { lanes, type Lane } from "./lanes.ts";
import { laneModels } from "./laneviews.ts";

const lane = (name: string, model: string): Lane => ({ name, cwd: "/tmp", model, status: "idle", startedAt: "", reports: 0, ctx: {} as Lane["ctx"], lastText: "", proc: {} as Lane["proc"] });

beforeEach(() => lanes.clear());
afterEach(() => lanes.clear());

test("laneModels splits each lane's selector into model and thinking", () => {
	lanes.set("a", lane("a", "prov/model-x:high"));
	lanes.set("b", lane("b", "prov/model-y"));
	const [a, b] = laneModels();
	expect([a!.name, a!.model, a!.thinking]).toEqual(["a", "prov/model-x", "high"]);
	expect([b!.name, b!.model, b!.thinking]).toEqual(["b", "prov/model-y", lanesModel().thinking]);
});

test("the /api/models view resolves with the lanes in it", async () => {
	lanes.set("a", lane("a", "prov/model-x:high"));
	const view = await modelsView();
	expect(JSON.stringify(view)).toContain("prov/model-x");
});
