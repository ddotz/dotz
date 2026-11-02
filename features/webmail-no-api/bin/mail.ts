// Action CLI the orchestrator runs for one site: list / read / search / draft / send. Reading is free; drafting only writes
// a local draft record; sending is refused unless the owner approved it in the mail thread (the gateway also blocks the
// raw `send` command through a deny line until then), so nothing ever leaves the account on the model's own judgment.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endpointUrl, type SiteSpec } from "../lib/spec.ts";
import { headers } from "../lib/session.ts";
import { list, read, search, makeDraft, type Draft } from "../lib/adapter.ts";
import { loadConfig, loadSpec, liveCtx, paths, writeJson, type Ctx, type SiteConfig } from "../lib/config.ts";
import { cookieHeaderFromAside } from "../lib/cookies.ts";
import { draftFile, uploadFile, type UploadedFile } from "../lib/upload.ts";

const APPROVAL_TTL_MS = 15 * 60_000;

export const draftPath = (site: string, id: string) => join(paths.drafts(site), `${id}.json`);

// The marker stores the epoch ms the owner approved at, so freshness is judged against the same clock that wrote it (the
// gateway touches it only after an OK in the mail thread).
export function approveSend(site: string, now: number): void {
	writeJson(paths.approval(site), { approvedAt: now });
}

export function sendApproved(site: string, now: number): boolean {
	const f = paths.approval(site);
	if (!existsSync(f)) return false;
	try {
		const at = Number(JSON.parse(readFileSync(f, "utf8"))?.approvedAt);
		return Number.isFinite(at) && now - at < APPROVAL_TTL_MS;
	} catch {
		return false;
	}
}

export async function runList(ctx: Ctx, spec: SiteSpec): Promise<{ lines: string[]; code: number }> {
	const { state, mails } = await list(ctx, spec);
	if (state.kind === "loggedout") return { lines: [`로그인이 풀렸어요 (${state.why}). Aside에서 다시 로그인해 주세요`], code: 1 };
	if (state.kind === "error") return { lines: [`메일 목록을 못 가져왔어요: ${state.msg}`], code: 1 };
	return { lines: mails.slice(0, 30).map((m) => `${m.read ? " " : "•"} ${m.id}\t${m.time}\t${m.from}\t${m.subject}`), code: 0 };
}

export async function runRead(ctx: Ctx, spec: SiteSpec, id: string): Promise<{ lines: string[]; code: number }> {
	const d = await read(ctx, spec, id);
	return { lines: [d.body || "(본문 없음)"], code: 0 };
}

export async function runSearch(ctx: Ctx, spec: SiteSpec, q: string): Promise<{ lines: string[]; code: number }> {
	const mails = await search(ctx, spec, q);
	return { lines: mails.slice(0, 30).map((m) => `${m.id}\t${m.time}\t${m.from}\t${m.subject}`), code: 0 };
}

// `files` are paths; the draft keeps path, name and size only (the bytes are read from disk at send).
export function runDraft(site: string, now: number, input: { to: string; subject: string; body: string; cc?: string; files?: string[] }): { draft: Draft; code: number } {
	const draft = makeDraft(now, { ...input, files: (input.files ?? []).map(draftFile) });
	writeJson(draftPath(site, draft.id), draft);
	return { draft, code: 0 };
}

export async function runSend(ctx: Ctx, spec: SiteSpec, site: string, draftId: string, now: number): Promise<{ lines: string[]; code: number }> {
	const f = draftPath(site, draftId);
	if (!existsSync(f)) return { lines: [`초안 ${draftId}을(를) 찾지 못했어요`], code: 1 };
	if (!spec.send) return { lines: ["이 사이트 스펙에는 전송 엔드포인트가 없어요. 초안만 만들 수 있어요"], code: 1 };
	if (!sendApproved(site, now)) return { lines: [`전송은 메일 스레드에서 오너가 OK(ㅇㅇ/보내)해야 돼요. 초안 ${draftId}을(를) 보여주고 승인을 기다려 주세요`], code: 2 };
	const draft = JSON.parse(readFileSync(f, "utf8")) as Draft;
	const cookie = await ctx.cookieHeader(spec);
	// Every file must be accepted before the mail goes out; one refusal stops here, so no mail leaves half-attached.
	const files: UploadedFile[] = [];
	if (draft.files?.length) {
		if (!spec.send.upload) return { lines: [`이 사이트 스펙에는 파일 올리기(send.upload)가 없어서 파일이 붙은 초안 ${draftId}은(는) 보내지 않았어요`], code: 1 };
		for (const df of draft.files) {
			try {
				files.push(await uploadFile(ctx, spec, cookie, df));
			} catch (error) {
				return { lines: [`첨부를 다 올리지 못해서 보내지 않았어요: ${(error as Error).message}`, `올라간 파일 ${files.length}/${draft.files.length}개. 초안과 승인은 그대로예요`], code: 1 };
			}
		}
	}
	const attached = files.length ? { [spec.send.upload?.sendField ?? "attachments"]: files.map(({ name, size, id, link, url }) => ({ name, size, id, ...(link ? { link } : {}), ...(url ? { url } : {}) })) } : {};
	const url = endpointUrl(spec.origin, spec.send, {});
	const r = await ctx.fetch(url, { method: spec.send.method ?? "POST", headers: headers(spec, cookie, { "Content-Type": "application/json", Accept: "application/json" }), body: JSON.stringify({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, ...attached }), signal: AbortSignal.timeout(30_000) });
	if (!r.ok) return { lines: [`전송 실패: HTTP ${r.status}`], code: 1 };
	rmSync(paths.approval(site), { force: true });
	rmSync(f, { force: true });
	const links = files.filter((x) => x.link).length;
	return { lines: [`보냈어요: ${draft.subject} → ${draft.to}${files.length ? ` (첨부 ${files.length}개${links ? `, 그중 대용량 링크 ${links}개` : ""})` : ""}`], code: 0 };
}

export function listDrafts(site: string): Draft[] {
	const dir = paths.drafts(site);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Draft);
}

async function main(argv: string[]): Promise<number> {
	const [site, cmd, ...rest] = argv;
	const spec = loadSpec(site ?? "");
	const config: SiteConfig | undefined = loadConfig(site ?? "");
	if (!spec || !config) {
		console.log(`"${site}" 메일은 아직 연결 전이에요. onboard.ts로 연결하면 쓸 수 있어요`);
		return 1;
	}
	const ctx = liveCtx(cookieHeaderFromAside);
	const now = Date.now();
	let out: { lines: string[]; code: number };
	switch (cmd) {
		case "list":
			out = await runList(ctx, spec);
			break;
		case "read":
			out = await runRead(ctx, spec, rest[0]);
			break;
		case "search":
			out = await runSearch(ctx, spec, rest.join(" "));
			break;
		case "draft": {
			const files: string[] = [];
			const args = rest.filter((a, i) => {
				if (a === "--file") return false;
				if (rest[i - 1] === "--file") return void files.push(a);
				return true;
			});
			const [to = "", subject = "", ...words] = args;
			try {
				const { draft } = runDraft(site, now, { to, subject, body: words.join(" "), files });
				out = { lines: [`초안 저장: ${draft.id}${draft.files ? ` (파일 ${draft.files.length}개)` : ""}`], code: 0 };
			} catch (error) {
				out = { lines: [(error as Error).message], code: 1 };
			}
			break;
		}
		case "approve":
			approveSend(site, now);
			out = { lines: [`전송 승인됨 (15분 유효): ${site}`], code: 0 };
			break;
		case "send":
			out = await runSend(ctx, spec, site, rest[0], now);
			break;
		default:
			out = { lines: ["사용법: list | read <id> | search <말> | draft <받는이> <제목> <본문...> [--file <경로>]... | approve | send <초안id>"], code: 1 };
	}
	for (const l of out.lines) console.log(l);
	return out.code;
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
