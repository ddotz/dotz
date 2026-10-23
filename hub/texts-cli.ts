// Text overrides of this install (hub/texts.ts): `list`, `show <key>` (shipped text + hash), `set <key> <text> | --file <path>`, `remove <key>`.
import { readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { CATALOGS, lang, LOCKED_TEXTS } from "./i18n.ts";
import { baseLanguage } from "./language.ts";
import { defaultHash, defaultTemplate, readTexts, setText, textProblems, textsPath } from "./texts.ts";

const base = CATALOGS[baseLanguage(lang())] ?? CATALOGS.en;
const [cmd, key, ...rest] = process.argv.slice(2);
const need = (): string => key ?? (console.error("키가 필요해요"), process.exit(2));

if (cmd === "list") {
	const bad = new Map(textProblems(base, DATA_DIR, LOCKED_TEXTS).map(p => [p.key, p.kind]));
	for (const [k, e] of Object.entries(readTexts(DATA_DIR))) console.log(`${k}\t${bad.get(k) ?? "ok"}\t${e.text.slice(0, 60).replace(/\n/g, " ")}`);
} else if (cmd === "show") {
	const t = defaultTemplate(base, need(), LOCKED_TEXTS);
	if (t === undefined) (console.error(`"${key}"는 고칠 수 있는 키가 아니에요`), process.exit(1));
	console.log(`hash ${defaultHash(base, key, LOCKED_TEXTS)}\n${t}`);
} else if (cmd === "set") {
	const text = rest[0] === "--file" ? readFileSync(rest[1], "utf8").replace(/\n$/, "") : rest.join(" ");
	if (!text) (console.error("문구가 필요해요"), process.exit(2));
	setText(base, DATA_DIR, need(), text, LOCKED_TEXTS);
	console.log(`${key} 문구를 ${textsPath(DATA_DIR)}에 저장했어요`);
} else if (cmd === "remove") {
	const all = readTexts(DATA_DIR);
	delete all[need()];
	writeFileSync(textsPath(DATA_DIR), `${JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, e]) => [k, e.default ? e : e.text])), null, 1)}\n`);
	console.log(`${key} 문구를 지웠어요`);
} else {
	console.error("usage: texts-cli.ts list | show <key> | set <key> <text>|--file <path> | remove <key>");
	process.exit(2);
}
