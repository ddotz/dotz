// One-request onboarding for a mail site zele cannot reach: preflight -> login (the browser's saved password, background)
// -> record the client's calls -> generate the adapter -> live list + read test (with a read-endpoint probe) -> config,
// card, sidebar, feature switch -> new-mail watch and session-keeping watch -> the site's own 메일 app instance (its 모니터링 row, settings,
// 연결 끊김 state; docs/custom-plugins.md "Registering a mail reader as a mail instance"). Every step is idempotent and the state file
// records where it is, so an interrupted run resumes at that step. Every owner action (a missing saved password, a second
// factor) is gathered into one ask; the next run with `approve` carries on to the end. Progress is one evolving message.
// All side effects go through `Io`, so the whole flow runs against a fake mail server in the tests.
import { existsSync, readFileSync } from "node:fs";
import { capture, readCandidates, type CapturedRequest } from "./capture.ts";
import { list, probeRead, read } from "./adapter.ts";
import { loadConfig, loadSpec, paths, writeJson, type Ctx, type SiteConfig } from "./config.ts";
import { type Gateway } from "./gateway.ts";
import { apply, sessionWatchSpec, watchSpec } from "../bin/setup.ts";
import type { SiteSpec } from "./spec.ts";

export const STEPS = ["preflight", "login", "capture", "test", "apply", "watch", "app"] as const;
export type Step = (typeof STEPS)[number];
export const STEP_LABEL: Record<Step, string> = {
	preflight: "사전 확인",
	login: "로그인 (Aside 백그라운드)",
	capture: "메일 호출 기록",
	test: "목록·읽기 시험",
	apply: "설정·홈 카드",
	watch: "새 메일 감시·로그인 유지",
	app: "모니터링 메일 앱",
};

export type OnboardState = {
	version: 1;
	site: string;
	url: string;
	channel?: string;
	label?: string;
	done: Step[];
	current?: Step;
	status: "running" | "waiting" | "failed" | "done";
	message?: string;
	ask?: string;
	loginTries: number;
	readGuessed?: boolean;
	summary?: string;
	updated: string;
};

export type LoginResult = "in" | "need-2fa" | "need-password" | "failed";
export type Io = {
	ctx: Ctx;
	mailElsewhere(): string | undefined;
	asideReady(): Promise<boolean>;
	loginState(url: string): Promise<"in" | "form" | "unknown">;
	login(url: string, allowSecondFactor: boolean): Promise<LoginResult>;
	record(url: string, deep: boolean): Promise<CapturedRequest[]>;
	gateway: Gateway;
	progress(text: string): Promise<void>;
};

export type OnboardOpts = { site: string; url?: string; channel?: string; label?: string; approve?: boolean; har?: CapturedRequest[]; restart?: boolean };
export type OnboardResult = { status: OnboardState["status"]; step?: Step; message: string; ask?: string; state: OnboardState };

type StepOutcome = { ok: true; note?: string } | { ok: false; status: "waiting" | "failed"; message: string; ask?: string } | { back: Step; note: string };

const isUrl = (u: string) => {
	try {
		const p = new URL(u);
		return p.protocol === "https:" || (p.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(p.hostname));
	} catch {
		return false;
	}
};

export function loadOnboard(site: string): OnboardState | undefined {
	const f = paths.onboard(site);
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as OnboardState) : undefined;
}

export function render(s: OnboardState): string {
	const lines = [`메일 연결 · ${s.site}`];
	for (const step of STEPS) {
		const mark = s.done.includes(step) ? "✅" : s.current === step ? (s.status === "waiting" ? "❓" : s.status === "failed" ? "❌" : "⏳") : "·";
		lines.push(`${mark} ${STEP_LABEL[step]}`);
	}
	if (s.status === "done" && s.summary) lines.push("", s.summary);
	else if (s.message) lines.push("", s.message);
	if (s.ask) lines.push("", s.ask);
	return lines.join("\n");
}

export function loginAsk(site: string, needPassword: boolean): string {
	return [
		`${site} 로그인에 직접 해 주실 일이 한 번 있어요. 아래만 해 주시면 그다음은 끝까지 알아서 해요.`,
		...(needPassword ? ["1) Aside에 이 사이트 비밀번호가 저장돼 있지 않아요. Aside에서 한 번 로그인하면서 비밀번호 저장을 눌러 주세요"] : []),
		`${needPassword ? "2" : "1"}) 로그인할 때 2차 인증(문자·앱 승인·보안키)이 오면 승인해 주세요`,
		"준비되면 \"됐어\"라고 답해 주세요.",
	].join("\n");
}

export const appLabelOf = (s: Pick<OnboardState, "site" | "label">): string => s.label ?? `${s.site} 메일`;

// The site as its own instance of the 메일 app (POST /api/apps): it owns the mails its watch posts (`source` = the site, watchkit.ts postToGateway),
// the watches onboarding registers (so their failures are its 연결 끊김, never the default 메일 row's) and the site's data folder. The id is fixed
// per site, so a rerun is answered 409 and adds nothing.
export function appInstance(site: string, label: string, spec: SiteSpec, config: SiteConfig) {
	const session = sessionWatchSpec(spec, config);
	return { app: "mail", id: `mail-${site}`, label, filter: { source: site, watches: [watchSpec(site, config).name as string, ...(session ? [session.name as string] : [])], data: [`custom/webmail/${site}`] } };
}

async function runStep(io: Io, s: OnboardState, step: Step, opts: OnboardOpts): Promise<StepOutcome> {
	switch (step) {
		case "preflight": {
			const elsewhere = io.mailElsewhere();
			if (elsewhere) return { ok: false, status: "failed", message: `이 설치는 메일을 다른 컴퓨터가 맡도록 돼 있어요 (${elsewhere}). 그 컴퓨터에서 연결해 주세요` };
			if (!isUrl(s.url)) return { ok: false, status: "failed", message: `받은메일함 주소가 올바르지 않아요: ${s.url} (https://로 시작해야 해요)` };
			if (!(await io.asideReady())) return { ok: false, status: "failed", message: "Aside 브라우저를 찾지 못했어요. Aside를 설치하고 로그인한 뒤 다시 하면 이 단계부터 이어서 해요" };
			return { ok: true };
		}
		case "login": {
			const state = await io.loginState(s.url);
			if (state !== "form") return { ok: true, note: state === "in" ? "이미 로그인돼 있어요" : "로그인 화면이 안 보여서 다음 단계에서 확인해요" };
			const r = await io.login(s.url, !!opts.approve);
			if (r === "in") return { ok: true, note: "저장된 비밀번호로 로그인했어요" };
			if (r === "need-password") return { ok: false, status: "waiting", message: "Aside에 저장된 비밀번호가 없어요", ask: loginAsk(s.site, true) };
			if (r === "need-2fa") {
				if (opts.approve) return { ok: false, status: "waiting", message: "2차 인증 승인을 기다리는 중이에요", ask: `${s.site} 2차 인증 요청을 보냈어요. 승인한 뒤 "됐어"라고 답해 주세요.` };
				return { ok: false, status: "waiting", message: "2차 인증이 필요해요 (OK 전에는 보내지 않아요)", ask: loginAsk(s.site, false) };
			}
			s.loginTries++;
			return { ok: false, status: "failed", message: s.loginTries >= 2 ? "로그인을 두 번 실패했어요. 계정이 잠기지 않게 멈췄어요. 비밀번호가 바뀌었는지 확인해 주세요" : "로그인을 못 했어요. 다시 실행하면 한 번 더 시도해요" };
		}
		case "capture": {
			let reqs = opts.har ?? (await io.record(s.url, false));
			let res = capture(s.site, reqs);
			if (res.kind !== "ok" && !opts.har) {
				reqs = [...reqs, ...(await io.record(s.url, true))];
				res = capture(s.site, reqs);
			}
			if (res.kind !== "ok" || !res.spec) {
				if (!reqs.length && s.loginTries < 1) {
					s.loginTries++;
					return { back: "login", note: "호출이 하나도 안 보여서 로그인부터 다시 확인해요" };
				}
				return { ok: false, status: "failed", message: [...res.notes, "HAR 파일을 주시면 `--har <파일>`로 이 단계부터 이어서 해요"].join("\n") };
			}
			writeJson(paths.spec(s.site), res.spec);
			s.readGuessed = !!res.readGuessed;
			return { ok: true, note: res.notes[res.notes.length - 1] };
		}
		case "test": {
			const spec = loadSpec(s.site);
			if (!spec) return { back: "capture", note: "설정 파일이 없어서 호출 기록부터 다시 해요" };
			const { state, mails } = await list(io.ctx, spec);
			if (state.kind === "loggedout") {
				if (s.loginTries < 1) {
					s.loginTries++;
					return { back: "login", note: "시험 중 로그인이 풀려서 로그인부터 다시 해요" };
				}
				return { ok: false, status: "failed", message: `목록을 열면 로그인이 풀려 있어요 (${state.why}). Aside에서 한 번 로그인한 뒤 다시 실행해 주세요` };
			}
			if (state.kind === "error") return { ok: false, status: "failed", message: `메일 목록을 못 가져왔어요: ${state.msg}. 다시 실행하면 이 단계부터 해요` };
			if (!mails.length) return { ok: true, note: "받은메일함이 비어 있어서 읽기 시험은 첫 메일이 오면 해요" };
			const id = mails[0].id;
			let readOk = false;
			if (!s.readGuessed) {
				try {
					await read(io.ctx, spec, id);
					readOk = true;
				} catch {
					readOk = false;
				}
			}
			if (!readOk) {
				const found = await probeRead(io.ctx, spec, id, [...(s.readGuessed ? [] : [spec.read]), ...readCandidates(spec)]);
				if (!found) return { ok: false, status: "failed", message: "메일 목록은 되는데 메일 본문을 여는 주소를 못 찾았어요. 받은메일함에서 메일 한 통을 연 상태로 저장한 HAR을 `--har <파일>`로 주시면 이어서 해요" };
				spec.read = found;
				writeJson(paths.spec(s.site), spec);
				await read(io.ctx, spec, id);
				s.readGuessed = false;
			}
			return { ok: true, note: `목록 ${mails.length}통, 읽기 확인` };
		}
		case "apply": {
			apply({ site: s.site, channel: s.channel, label: appLabelOf(s) });
			return { ok: true };
		}
		case "watch": {
			const spec = loadSpec(s.site);
			const config = loadConfig(s.site);
			if (!spec || !config) return { back: "capture", note: "설정 파일이 없어서 다시 만들어요" };
			await io.gateway("POST", "/api/watches", watchSpec(s.site, config));
			const session = sessionWatchSpec(spec, config);
			if (session) await io.gateway("POST", "/api/watches", session);
			return { ok: true, note: session ? "로그인 유지는 게이트웨이가 모델 없이 해요" : "https가 아닌 주소라 로그인 유지 감시는 건너뛰었어요" };
		}
		case "app": {
			const spec = loadSpec(s.site);
			const config = loadConfig(s.site);
			if (!spec || !config) return { back: "capture", note: "설정 파일이 없어서 다시 만들어요" };
			const label = appLabelOf(s);
			try {
				await io.gateway("POST", "/api/apps", appInstance(s.site, label, spec, config));
			} catch (e) {
				if ((e as { status?: number }).status !== 409) {
					return { ok: false, status: "failed", message: `새 메일 감시는 등록됐지만 모니터링에 "${label}" 행을 아직 못 만들었어요 (${e instanceof Error ? e.message : String(e)}). 게이트웨이가 켜지면 같은 명령을 다시 실행해 주세요. 이 단계만 다시 해요` };
				}
			}
			return { ok: true, note: `모니터링에 "${label}" 행이 생겨요. 로그인이 풀리면 이 행에 연결 끊김으로 보여요` };
		}
	}
}

export async function runOnboard(io: Io, opts: OnboardOpts): Promise<OnboardResult> {
	const prev = opts.restart ? undefined : loadOnboard(opts.site);
	if (!prev && !opts.url) {
		const s: OnboardState = { version: 1, site: opts.site, url: "", done: [], status: "failed", message: "처음 연결할 때는 받은메일함 주소(--url)가 필요해요", loginTries: 0, updated: new Date(io.ctx.now()).toISOString() };
		return { status: "failed", message: s.message!, state: s };
	}
	const s: OnboardState = prev
		? { ...prev, ...(opts.url ? { url: opts.url } : {}), ...(opts.channel ? { channel: opts.channel } : {}), ...(opts.label ? { label: opts.label } : {}), status: "running", ask: undefined, message: undefined }
		: { version: 1, site: opts.site, url: opts.url!, ...(opts.channel ? { channel: opts.channel } : {}), ...(opts.label ? { label: opts.label } : {}), done: [], status: "running", loginTries: 0, updated: "" };
	if (opts.approve && s.current === "login") s.loginTries = 0;
	const save = async () => {
		s.updated = new Date(io.ctx.now()).toISOString();
		writeJson(paths.onboard(s.site), s);
		await io.progress(render(s)).catch(() => undefined);
	};
	const notes: string[] = [];
	for (let guard = 0; guard < STEPS.length * 3; guard++) {
		const step = STEPS.find((x) => !s.done.includes(x));
		if (!step) break;
		s.current = step;
		s.status = "running";
		s.message = undefined;
		await save();
		let out: StepOutcome;
		try {
			out = await runStep(io, s, step, opts);
		} catch (e) {
			out = { ok: false, status: "failed", message: `${STEP_LABEL[step]}에서 멈췄어요: ${e instanceof Error ? e.message : String(e)}. 다시 실행하면 이 단계부터 이어서 해요` };
		}
		if ("back" in out) {
			notes.push(out.note);
			s.done = s.done.filter((d) => STEPS.indexOf(d) < STEPS.indexOf(out.back));
			continue;
		}
		if (!out.ok) {
			s.status = out.status;
			s.message = out.message;
			s.ask = out.ask;
			await save();
			return { status: s.status, step, message: out.message, ask: out.ask, state: s };
		}
		if (out.note) notes.push(out.note);
		s.done.push(step);
	}
	s.current = undefined;
	s.status = "done";
	s.summary = [`연결이 끝났어요. 새 메일은 ${s.channel ? `<#${s.channel.slice(3)}>` : "메일 채널"}에 메일마다 스레드로 와요.`, ...notes.filter(Boolean).map((n) => `- ${n}`)].join("\n");
	await save();
	return { status: "done", message: s.summary, state: s };
}
