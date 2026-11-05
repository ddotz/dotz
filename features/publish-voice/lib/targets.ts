// What may be read, and the guard that enforces it. `scope add` is the only way the list grows; every read goes through guardPath / guardUrl, which
// throw for anything that is not on the list. Company mail and sensitive places are refused (exit 3) until the user was asked and `--asked` is given.
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { sensitiveReason, walkFolder, TEXT_EXTENSIONS } from "./folders.ts";
import { blocked, done, failed, type Out } from "./out.ts";
import type { Kind } from "./profile.ts";
import { loadJson, rootPaths, saveJson, validVoice } from "./store.ts";
import { readMeta } from "./voices.ts";

export type TargetType = "folder" | "file" | "url" | "blog" | "mail" | "messages";
export type Target = { id: string; type: TargetType; kind: Kind; voice: string; path?: string; url?: string; account?: string; limit?: number; asked?: boolean; sentence: string };
export type Scope = { targets: Target[] };
export type AddSpec = { type: TargetType; kind: Kind; voice?: string; path?: string; url?: string; account?: string; limit?: string; asked: boolean };

export class OutOfScopeError extends Error {}

export const PERSONAL_MAIL = ["gmail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "outlook.com", "hotmail.com", "icloud.com", "me.com", "yahoo.com", "proton.me", "protonmail.com", "nate.com"];
export const DEFAULT_LIMIT: Record<"blog" | "mail" | "messages", number> = { blog: 50, mail: 200, messages: 500 };
const MAX_LIMIT = 5000;

export const readScope = (root: string): Scope => loadJson<Scope>(rootPaths(root).scope, { targets: [] });
const writeScope = (root: string, scope: Scope): void => saveJson(rootPaths(root).scope, scope);

const within = (real: string, base: string): boolean => real === base || real.startsWith(base + sep);

export function guardPath(scope: Scope, file: string): string {
	const real = realpathSync(file);
	const allowed = scope.targets.some(t => {
		if (!t.path) return false;
		return t.type === "folder" ? within(real, realpathSync(t.path)) : t.type === "file" && real === realpathSync(t.path);
	});
	if (!allowed) throw new OutOfScopeError(`${file}은(는) 말한 범위 밖이라 읽지 않아요`);
	return real;
}

// A blog's own subdomains (rss.blog.naver.com, m.blog.naver.com for blog.naver.com) belong to the same blog; its parent domain and other hosts do not.
const bare = (host: string): string => host.replace(/^www\./, "");
export const sameSite = (host: string, blogHost: string): boolean => {
	const [h, b] = [bare(host), bare(blogHost)];
	return h === b || h.endsWith(`.${b}`);
};

export function guardUrl(scope: Scope, url: string): string {
	const u = new URL(url);
	const allowed = scope.targets.some(t => {
		if (!t.url) return false;
		return t.type === "url" ? t.url === url : t.type === "blog" && sameSite(u.hostname, new URL(t.url).hostname);
	});
	if (!allowed || !/^https?:$/.test(u.protocol)) throw new OutOfScopeError(`${url}은(는) 말한 범위 밖이라 읽지 않아요`);
	return url;
}

const identity = (s: AddSpec, voice: string) => [s.type, voice, s.path, s.url, s.account].join("|");

function sentenceOf(s: AddSpec, extra: { exts?: string; count?: number; left?: number; limit?: number; host?: string }): string {
	switch (s.type) {
		case "folder": return extra.left ? `이 폴더의 ${extra.exts} 파일 ${extra.count}개(${s.path}). 경로가 민감해 보이는 ${extra.left}개는 뺐어요` : `이 폴더의 ${extra.exts} 파일 전부(${s.path}, ${extra.count}개)`;
		case "file": return `이 파일 하나(${s.path})`;
		case "url": return `이 주소의 글 하나(${s.url})`;
		case "blog": return `${extra.host} 블로그의 글 최근 ${extra.limit}개`;
		case "mail": return `${PERSONAL_MAIL.includes((s.account ?? "").split("@")[1]?.toLowerCase() ?? "") ? "개인" : "회사"} 메일 ${s.account}의 보낸 메일 최근 ${extra.limit}통`;
		case "messages": return `dotz에 보낸 내 메시지 최근 ${extra.limit}개`;
		default: return assertNever(s.type);
	}
}

function assertNever(x: never): never {
	throw new Error(`알 수 없는 대상 유형: ${String(x)}`);
}

function limitOf(s: AddSpec): number | string | undefined {
	if (s.type !== "blog" && s.type !== "mail" && s.type !== "messages") return undefined;
	if (s.limit === undefined) return DEFAULT_LIMIT[s.type];
	const n = Number(s.limit);
	return /^\d+$/.test(s.limit) && n >= 1 && n <= MAX_LIMIT ? n : `--limit은 1~${MAX_LIMIT} 사이 숫자여야 해요. 끝이 없는 범위는 받지 않아요`;
}

export function addTarget(root: string, spec: AddSpec): Out {
	const voice = spec.voice ?? (spec.kind === "self" ? "me" : "");
	if (!validVoice(voice)) return failed(spec.kind === "other" ? "다른 사람 글은 --voice <이름>이 필요해요(글자, 숫자, -, _ 30자 이내)" : "--voice 이름이 올바르지 않아요");
	if (spec.kind === "other" && (spec.type === "mail" || spec.type === "messages")) return failed("메일과 메시지는 내 글만 읽어요(--kind self)");
	const known = readMeta(root, voice);
	if (known && known.kind !== spec.kind) return failed(`${voice} 목소리는 이미 ${known.kind === "self" ? "내 글" : "다른 사람 글"}로 있어요. 다른 이름을 쓰세요`);
	const mixed = readScope(root).targets.find(t => t.voice === voice && t.kind !== spec.kind);
	if (mixed) return failed(`${voice} 목소리에는 이미 ${mixed.kind === "self" ? "내 글" : "다른 사람 글"} 대상이 있어요. 다른 이름을 쓰세요`);
	const limit = limitOf(spec);
	if (typeof limit === "string") return failed(limit);

	const extra: Parameters<typeof sentenceOf>[1] = { ...(limit ? { limit } : {}) };
	let real: string | undefined;
	if (spec.type === "folder" || spec.type === "file") {
		if (!spec.path || !existsSync(spec.path)) return failed(`경로를 찾지 못했어요: ${spec.path ?? "(--path 없음)"}`);
		real = realpathSync(resolve(spec.path));
		const isDir = statSync(real).isDirectory();
		if ((spec.type === "folder") !== isDir) return failed(`${spec.type === "folder" ? "폴더" : "파일"}가 아니에요: ${real}`);
		if (spec.type === "file" && !TEXT_EXTENSIONS.some(x => x === extname(real ?? "").toLowerCase())) return failed(`읽을 수 없는 파일 형식이에요(${TEXT_EXTENSIONS.join(" ")})`);
		if (isDir) {
			const walk = walkFolder(real, spec.asked);
			if (walk.tooMany) return failed(`${real}에 파일이 너무 많아요(5000개 넘음). 더 좁은 폴더를 고르세요`);
			const counts = new Map<string, number>();
			for (const f of walk.files) counts.set(extname(f).slice(1).toLowerCase(), (counts.get(extname(f).slice(1).toLowerCase()) ?? 0) + 1);
			extra.exts = [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k).join("·") || "글";
			extra.count = walk.files.length;
			extra.left = walk.sensitive;
		}
	} else if (spec.type === "url" || spec.type === "blog") {
		if (!spec.url || !/^https?:\/\/[^\s/]+/.test(spec.url)) return failed("--url에 http(s):// 주소가 필요해요");
		const u = new URL(spec.url);
		extra.host = `${u.host}${u.pathname.replace(/\/+$/, "")}`;
	} else if (spec.type === "mail" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(spec.account ?? "")) return failed("--account에 메일 주소가 필요해요");

	const target = { ...spec, ...(real ? { path: real } : {}) };
	const sentence = spec.kind === "other" ? `다른 사람 글 '${voice}': ${sentenceOf(target, extra)} (통계와 해시만 남기고 원문은 저장하지 않아요)` : sentenceOf(target, extra);
	const reason = real ? sensitiveReason(real) : spec.type === "mail" && !PERSONAL_MAIL.includes((spec.account ?? "").split("@")[1]?.toLowerCase() ?? "") ? "개인 메일 도메인 목록에 없는 회사 메일이에요" : undefined;
	if (reason && !spec.asked) return blocked(sentence, `${reason}. 읽어도 되는지 사용자에게 먼저 묻고, 허락하면 --asked를 붙여 같은 명령을 다시 실행하세요.`);

	const id = createHash("sha1").update(identity(target, voice)).digest("hex").slice(0, 6);
	const scope = readScope(root);
	const entry: Target = { id, type: spec.type, kind: spec.kind, voice, sentence, ...(target.path ? { path: target.path } : {}), ...(spec.url ? { url: spec.url } : {}), ...(spec.account ? { account: spec.account } : {}), ...(limit ? { limit } : {}), ...(spec.asked ? { asked: true } : {}) };
	writeScope(root, { targets: [...scope.targets.filter(t => t.id !== id), entry] });
	const next = "이 문장을 사용자에게 그대로 말한 뒤, 허락을 기다리지 않고 바로 analyze를 실행하세요. 말한 범위 밖은 읽지 않아요.";
	const left = extra.left ? `경로가 민감해 보이는 파일 ${extra.left}개는 읽지 않아요. 포함하려면 사용자에게 먼저 묻고, 허락하면 --asked를 붙여 같은 명령을 다시 실행하세요.` : undefined;
	return done(`범위에 더했어요 [${id}]: ${sentence}`, next, ...(left ? [left] : []));
}

export function removeTarget(root: string, id: string): Out {
	const scope = readScope(root);
	if (!scope.targets.some(t => t.id === id)) return failed(`범위에 ${id}가 없어요`);
	writeScope(root, { targets: scope.targets.filter(t => t.id !== id) });
	return done(`범위에서 뺐어요: ${id}`);
}
