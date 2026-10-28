#!/usr/bin/env bun
// The bot's and its scripts' way to a dotz_auth value now that it is stored encrypted (hub/secretbox.ts): pipe it straight into what needs
// it, never print it into a chat, log or report.
//   bun hub/secrets-cli.ts get <name> [field]   the stored JSON, or one field of it, on stdout
//   bun hub/secrets-cli.ts seal                 encrypts the plain values left in the secrets folder (the gateway also does this at start)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { readSecretFile, sealPlainSecrets } from "./secretbox.ts";

const [cmd, name, field] = process.argv.slice(2);
const dir = join(DATA_DIR, "secrets");
if (cmd === "seal") {
	const done = sealPlainSecrets(dir);
	console.log(done.length ? `sealed: ${done.join(", ")}` : "nothing to seal");
} else if (cmd === "get" && name && /^[A-Za-z0-9._/-]+$/.test(name) && !name.includes("..")) {
	const file = join(dir, name);
	if (!existsSync(file)) {
		console.error(`no secret ${name}`);
		process.exit(1);
	}
	const text = readSecretFile(file);
	if (!field) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	else {
		const v = (JSON.parse(text) as Record<string, unknown>)[field];
		if (typeof v !== "string") {
			console.error(`secret ${name} has no field ${field}`);
			process.exit(1);
		}
		process.stdout.write(v);
	}
} else {
	console.error("usage: secrets-cli.ts get <name> [field] | seal");
	process.exit(2);
}
