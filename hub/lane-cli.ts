// Run by a lane (DOTZ_LANE set) to record a change it made on the owner's word, so every view shows it at once:
// `worker <model[:effort]>` = the model its task workers now run on (PUT /api/target worker_model, by=lane).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PORT } from "./config.ts";

const [cmd, model] = process.argv.slice(2);
const lane = process.env.DOTZ_LANE;
if (cmd !== "worker" || !model || !lane) {
	console.error("usage (inside a lane session): lane-cli.ts worker <model[:effort]>");
	process.exit(2);
}
const url = `http://127.0.0.1:${PORT}/api/target`;
const token = readFileSync(join(DATA_DIR, "secrets", "hub-token"), "utf8").trim();
const r = await fetch(url, { method: "PUT", headers: { "x-dotz-token": token, "Content-Type": "application/json" }, body: JSON.stringify({ target: `lane:${lane}`, worker_model: model, by: "lane" }) });
const data = (await r.json().catch(() => ({}))) as { worker_model?: string; error?: string };
if (!r.ok) {
	console.error(`not recorded: ${data.error ?? r.status}`);
	process.exit(1);
}
console.log(`recorded: workers on ${data.worker_model}`);
