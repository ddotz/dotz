// One request turns a comment source on, end to end and resumable (every step checks its own state, so a second run continues):
//   on --app youtube|instagram|site [--name <site>] [--import-from <file-or-dir> (repeatable)] [--import-yt <file>] [--import-ig <file>] [--import-legacy | --no-import-legacy] [--label <text>] [--read-kind rss|json|script --read <url|command>]
//      [--post-kind webhook|script --post <url|command> [--secret <file in ~/.dotz/secrets>]] [--owner <name on the site>] [--to <target>]
//   off --app <key>   |   status
// Steps: connection check (exit 3 with the command the bot runs next to connect; only secrets and 2FA reach the owner) -> source config -> personal
// feature switch -> tone from his past replies -> the `comments` watch (and the old per-platform comment watch paused) -> first read.
// A site also becomes its own app instance (POST /api/apps {app:"site", id:"site-<name>", filter:{source:<name>}}): its own row, comment view and settings.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SiteConfig, SourceConfig, SourceKind } from "../../../hub/comments/contract.ts";
import type { Engine } from "../../../hub/comments/engine.ts";
import { realEngine } from "../../../hub/comments/real.ts";
import { createHub } from "../../../hub/kakao/hub.ts";
import { loadConfig } from "../../youtube-instagram/lib/config.ts";
import { IMPORT_HINT, legacyGate } from "../../youtube-instagram/lib/legacy.ts";
import { cleanExample } from "../../youtube-instagram/lib/reply-adapter.ts";
import { dataDir, writeExamples } from "../../reply-drafts/lib/settings.ts";
import { pickExamples } from "../../reply-drafts/lib/tone.ts";

type Out = { lines: string[]; code: number };
export type Gateway = { watches: () => Promise<string[]>; add: (body: Record<string, unknown>) => Promise<void>; pause: (name: string) => Promise<void>; app?: (body: Record<string, unknown>) => Promise<void> };

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const FEATURE = join(import.meta.dir, "..");
const WATCH = "comments";
const OLD_WATCH: Record<string, string> = { youtube: "sns-yt-comments", instagram: "sns-ig-comments" };
const WORD: Record<string, string> = { youtube: "유튜브", instagram: "인스타", site: "웹사이트" };
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const realGateway = (dir: string): Gateway => {
	const hub = createHub(dir);
	return {
		watches: async () => {
			const r = await hub.get("/api/watches");
			const list: any[] = Array.isArray(r.json) ? r.json : (r.json?.watches ?? r.json?.items ?? []);
			return list.map(w => String(w?.name ?? ""));
		},
		add: async body => {
			const r = await hub.post("/api/watches", body);
			if (r.status >= 300) throw new Error(`gateway ${r.status}`);
		},
		pause: async name => void (await hub.patch(`/api/watches/${name}`, { paused: true })),
		// 409 = the instance is already there (a second run).
		app: async body => {
			const r = await hub.post("/api/apps", body);
			if (r.status >= 300 && r.status !== 409) throw new Error(`gateway ${r.status}`);
		},
	};
};

const argv = (s: string | undefined): string[] | undefined => {
	if (!s) return undefined;
	if (s.trim().startsWith("[")) return JSON.parse(s) as string[];
	return s.trim().split(/\s+/);
};

function siteOf(args: string[]): SiteConfig | { missing: string[] } {
	const readKind = flag(args, "--read-kind") as SiteConfig["read"]["kind"] | undefined;
	const read = flag(args, "--read");
	const postKind = flag(args, "--post-kind") as SiteConfig["post"]["kind"] | undefined;
	const post = flag(args, "--post");
	const missing = [...(readKind && read ? [] : ["댓글을 읽는 방법 (RSS 주소, JSON 주소, 또는 읽기 스크립트)"]), ...(postKind && post ? [] : ["답글을 올리는 방법 (웹훅 주소나 API 주소, 또는 올리기 스크립트)"])];
	if (missing.length) return { missing };
	return {
		read: readKind === "script" ? { kind: "script", command: argv(read) } : { kind: readKind!, url: read },
		post: postKind === "script" ? { kind: "script", command: argv(post) } : { kind: "webhook", url: post, ...(flag(args, "--secret") ? { secret: flag(args, "--secret") } : {}) },
		...(flag(args, "--owner") ? { owner: flag(args, "--owner") } : {}),
	};
}

function writeSwitch(): void {
	const file = join(dataDir(), "features", "comments", "feature.md");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, readFileSync(join(FEATURE, "feature.md"), "utf8").replace(/^enabled:\s*false\s*$/m, "enabled: true"));
}

const connected = (kind: "youtube" | "instagram"): boolean => {
	try {
		return Boolean(loadConfig()[kind]);
	} catch {
		return false;
	}
};

export async function runOnboard(args: string[], deps: { engine?: Engine; gateway?: Gateway; connected?: (k: "youtube" | "instagram") => boolean } = {}): Promise<Out> {
	const [cmd] = args;
	const app = flag(args, "--app");
	const dir = dataDir();
	const engine = deps.engine ?? realEngine(dir);
	const gateway = deps.gateway ?? realGateway(dir);
	const store = engine.store;

	if (cmd === "status") {
		const cfg = store.config();
		return { lines: [cfg.enabled ? `댓글 연동이 켜져 있어요: ${Object.keys(cfg.sources).join(", ") || "고른 곳 없음"}` : "댓글 연동이 꺼져 있어요"], code: 0 };
	}
	if (cmd === "off") {
		const src = app ? store.config().sources[app] : undefined;
		if (!src) return { lines: [`끌 곳을 찾지 못했어요: ${app ?? "(--app 필요)"}`], code: 2 };
		store.setSource({ ...src, watch: [], autoDraft: false });
		return { lines: [`${src.label} 댓글 지켜보기를 껐어요. 이제 아무것도 읽지 않아요`], code: 0 };
	}
	if (cmd !== "on" || !app || !(app in WORD)) return { lines: ["usage: onboard.ts on --app youtube|instagram|site [options] | off --app <key> | status"], code: 2 };

	let kind: SourceKind;
	let key: string;
	let label: string;
	let site: SiteConfig | undefined;
	if (app === "site") {
		const name = (flag(args, "--name") ?? "").toLowerCase();
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 30) return { lines: ["사이트 이름이 필요해요 (--name, 영문 소문자·숫자·-)"], code: 2 };
		const s = siteOf(args);
		if ("missing" in s) return { lines: ["웹사이트 댓글을 켜려면 이것만 알려 주세요 (한 번에):", ...s.missing.map(m => `- ${m}`), "알려 주시면 같은 명령에 넣어서 이어서 해요"], code: 3 };
		[kind, key, label, site] = ["website", `site-${name}`, flag(args, "--label") ?? `웹사이트 댓글 (${name})`, s];
	} else {
		kind = app as "youtube" | "instagram";
		if (!(deps.connected ?? connected)(kind)) {
			const to = flag(args, "--to");
			const legacy = legacyGate(args);
			if (legacy.ask) return { lines: legacy.lines, code: 3 };
			return { lines: [...legacy.lines, `${WORD[app]}이(가) 아직 연결되지 않았어요. 연결은 이 명령을 실행해 직접 진행해요(비밀번호·2차 인증 같은 것만 사용자에게 한 번 물어요): bun ${join(FEATURE, "..", "youtube-instagram", "bin", "onboard.ts")} run --${app}${to ? ` --target ${to}` : ""}`, `연결이 끝나면 같은 명령(onboard.ts on --app ${app})을 다시 실행해요`, IMPORT_HINT], code: 3 };
		}
		[key, label] = [app, `${WORD[app]} 댓글`];
	}

	const prior = store.config().sources[key];
	const source: SourceConfig = { key, kind, label, watch: prior?.watch.length ? prior.watch : ["*"], autoDraft: prior?.autoDraft ?? false, ...(prior?.autoSince ? { autoSince: prior.autoSince } : {}), ...(site ? { site } : prior?.site ? { site: prior.site } : {}) };
	store.saveConfig({ enabled: true, sources: { ...store.config().sources, [key]: source } });
	writeSwitch();

	const lines: string[] = [];
	let code = 0;
	try {
		const own = await engine.ownReplies(key);
		const examples = pickExamples(own.map(cleanExample).filter(Boolean), 20);
		if (examples.length) {
			writeExamples({ app: key }, examples);
			lines.push(`내가 쓴 지난 답글 ${examples.length}개에서 말투를 배웠어요`);
		} else lines.push("지난 답글이 없어서 정중한 기본 말투로 시작해요. 고치기를 하면 거기서 배워요");
	} catch {
		lines.push("지난 답글을 읽지 못해서 정중한 기본 말투로 시작해요");
	}

	try {
		if (app === "site") await gateway.app?.({ app: "site", id: key, label: label.slice(0, 30), filter: { source: key.slice(5) } });
		const names = await gateway.watches();
		if (!names.includes(WATCH)) await gateway.add({ name: WATCH, command: `bun ${shq(join(FEATURE, "bin", "watch.ts"))}`, every_minutes: 5, on: "match", pattern: ".", to: "orchestrator", timeout_seconds: 300 });
		const old = OLD_WATCH[key];
		if (old && names.includes(old)) {
			await gateway.pause(old);
			lines.push(`예전 ${WORD[app]} 댓글 감시(${old})는 겹치지 않게 멈췄어요`);
		}
	} catch (e) {
		code = 4;
		lines.push(`감시를 등록하지 못했어요 (${(e as Error).message}). 게이트웨이가 켜진 뒤 같은 명령을 다시 실행하면 이어서 해요`);
	}

	try {
		const r = await engine.collect({ force: true });
		lines.push(r.errors[key] ? `첫 읽기가 실패했어요: ${r.errors[key]}` : `첫 읽기를 마쳤어요 (댓글 ${r.added.length}개)`);
		if (r.errors[key]) code = code || 4;
	} catch (e) {
		lines.push(`첫 읽기가 실패했어요: ${(e as Error).message}`);
		code = code || 4;
	}
	lines.unshift(`${label} 답글 도우미를 켰어요. 초안은 부탁할 때만 만들고, 사용자가 1) 보내기를 고르기 전에는 아무것도 올리지 않아요`);
	return { lines, code };
}

if (import.meta.main) {
	const r = await runOnboard(process.argv.slice(2));
	console.log(r.lines.join("\n"));
	process.exit(r.code);
}
