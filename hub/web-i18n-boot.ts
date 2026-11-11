// Starts the generator of the web app's generated screen-text lists (hub/web-i18n-gen.ts) with the gateway's real parts: the install's own
// one-shot model (hub/outlang.ts), the cache dir under the data dir, the lists the page itself is drawn from, and the install's language.
// Start signals: the gateway start (here), a model connection (providers.ts invalidate -> modelConnected), a language change (checked each
// minute here, and by the first-run gate when the draft's language moves), and changed ko/en sources after an update (the start pass compares).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authFile } from "./apikey-policy.ts";
import { cfg, DATA_DIR, log } from "./config.ts";
import { lang as installLang } from "./i18n.ts";
import { callModel } from "./outlang.ts";
import { omoAuthInfos } from "./providers.ts";
import { webWords } from "./texts.ts";
import { setAppLang, webSources } from "./webapp.ts";
import { setOwnerWords } from "./web-i18n.ts";
import { createGenerator, installGenerator, type Generator } from "./web-i18n-gen.ts";

const LANGUAGE_CHECK_MS = 60_000;

/** A stored OmO account, or the omp runtime (whose accounts omp keeps; a call without one fails and backs off). */
const connected = (): boolean => {
	if ((cfg.orchestrator?.runtime ?? cfg.runtime ?? "omo") === "omp") return true;
	try {
		return omoAuthInfos(JSON.parse(readFileSync(authFile(), "utf8")) as Record<string, unknown>).length > 0;
	} catch {
		return false;
	}
};

export function startWebI18n(opts: { lang?: () => string } = {}): Generator {
	setOwnerWords(() => webWords(DATA_DIR));
	const gen = createGenerator({
		call: (system, text, o) => callModel(system, text, o),
		dir: join(DATA_DIR, "cache", "web-i18n"),
		ko: () => webSources().ko,
		en: () => webSources().en,
		lang: opts.lang ?? installLang,
		connected,
		onLanguage: setAppLang,
		log,
	});
	installGenerator(gen);
	gen.install();
	void gen.signal("start");
	setInterval(() => void gen.signal("language"), LANGUAGE_CHECK_MS).unref();
	return gen;
}
