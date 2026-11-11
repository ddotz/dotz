// Writes web/js/01-message-spec.js from hub/message-spec.ts and hub/message-spec-derive.ts: the page runs the same catalog and the same grammar as the hub (bun hub/gen-message-spec-web.ts).
import { renameSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const NAMES = ["validateSpec", "specChildren", "elementPlain", "deriveSpec", "deriveBasicSpec"];
export async function buildMessageSpecWeb(): Promise<string> {
	const tr = new Bun.Transpiler({ loader: "ts" });
	const part = async (file: string) => tr.transformSync(await Bun.file(join(root, file)).text()).replace(/^import .*$/gm, "").replace(/^export /gm, "").replace(/^\s*\n/gm, "");
	const head = "// Generated from hub/message-spec.ts and hub/message-spec-derive.ts by hub/gen-message-spec-web.ts; do not edit.\n";
	return `${head}const { ${NAMES.join(", ")} } = (() => {\n${await part("hub/message-spec.ts")}${await part("hub/message-spec-derive.ts")}return { ${NAMES.join(", ")} };\n})();\n`;
}
if (import.meta.main) {
	const out = join(root, "web/js/01-message-spec.js");
	await Bun.write(`${out}.tmp`, await buildMessageSpecWeb());
	renameSync(`${out}.tmp`, out);
}
