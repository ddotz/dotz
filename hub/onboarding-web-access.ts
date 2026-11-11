import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import type { OnboardFlow, OnboardFlowContext, OnboardOwnerStep } from "./onboarding.ts";

// Web access through a Cloudflare tunnel (설정 → 웹 접속 → Cloudflare): the flow installs cloudflared, waits for the owner's one login
// approval, reuses the `dotz` tunnel, routes dotz.<zone> to it, and hands the tunnel token to hub/web-access.ts. The token is written only to
// <DATA_DIR>/secrets/cloudflared-tunnel-token (0600) and passed to applyWebAccess; no step, view, error or log line carries it.

const TUNNEL = "dotz";
const TOKEN_NAME = "cloudflared-tunnel-token";
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TOKEN = /^[A-Za-z0-9+/=_.-]{16,4096}$/;
const LOGIN_URL = /https:\/\/[^\s"'<>]+/;

const INSTALL_OWNER: OnboardOwnerStep = { label: "cloudflared 설치", hint: "터미널에서 `brew install cloudflared`를 실행한 뒤 계속을 누르세요." };
const LOGIN_OWNER: OnboardOwnerStep = { label: "Cloudflare 승인", hint: "브라우저에 열린 Cloudflare 화면에서 도메인을 선택해 승인한 뒤 계속을 누르세요." };
const TUNNEL_OWNER: OnboardOwnerStep = { label: "Cloudflare 터널 확인", hint: "Cloudflare 대시보드에 dotz 터널이 있는지 확인한 뒤 계속을 누르세요." };
const ZONE_OWNER: OnboardOwnerStep = { label: "Cloudflare 도메인 선택", hint: "브라우저에 열린 Cloudflare 대시보드에서 도메인을 연 뒤 계속을 누르세요." };
const ROUTE_OWNER: OnboardOwnerStep = { label: "Cloudflare 주소 확인", hint: "Cloudflare 대시보드에서 dotz 터널의 DNS 레코드를 확인한 뒤 계속을 누르세요." };
const VERIFY_OWNER: OnboardOwnerStep = { label: "Cloudflare 연결 확인", hint: "Cloudflare 대시보드에서 dotz 터널이 실행 중인지 확인한 뒤 계속을 누르세요." };

const homeOf = (ctx: OnboardFlowContext): string => ctx.deps.home ?? homedir();
const certPath = (ctx: OnboardFlowContext): string => join(homeOf(ctx), ".cloudflared", "cert.pem");
const hasCert = (ctx: OnboardFlowContext): boolean => existsSync(certPath(ctx));
const inputPath = (dir: string): string => join(dir, "onboarding", "web-access-input.json");

const cleanHostname = (value: unknown): string => {
	const s = typeof value === "string" ? value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
	return HOSTNAME.test(s) && s !== "dotz" ? s : "";
};

/** A hostname chosen earlier: the POST body (a small onboarding input file), the saved web-access.json, or config.json. */
function knownHostname(ctx: OnboardFlowContext): string {
	for (const rel of ["onboarding/web-access-input.json", "web-access.json"]) {
		const v = ctx.readJson(rel);
		const host = cleanHostname(v?.hostname);
		if (host) return host;
	}
	const cfg = ctx.readJson("config.json") as { web?: { cloudflare?: { hostname?: unknown } } } | undefined;
	return cleanHostname(cfg?.web?.cloudflare?.hostname);
}

function tunnelNames(out: string): string[] {
	const start = out.indexOf("[");
	const end = out.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	try {
		const list = JSON.parse(out.slice(start, end + 1));
		return Array.isArray(list) ? list.map(t => String((t as { name?: unknown })?.name ?? "")) : [];
	} catch {
		return [];
	}
}

function tokenOf(out: string): string {
	for (const line of out.split("\n")) {
		const s = line.trim();
		if (TOKEN.test(s)) return s;
	}
	const m = /[A-Za-z0-9+/=_.-]{16,4096}/.exec(out);
	return m && TOKEN.test(m[0]) ? m[0] : "";
}

async function cloudflaredPath(ctx: OnboardFlowContext): Promise<string> {
	try {
		const r = await ctx.deps.exec(["which", "cloudflared"]);
		return r.code === 0 ? (r.out.trim().split(/\s+/)[0] ?? "") : "";
	} catch {
		return "";
	}
}

/** Stores the hostname a POST /api/web-access/onboard body chose, for the flow's hostname step. Never a secret. */
export function saveWebAccessInput(dir: string, input: { hostname?: string }): void {
	mkdirSync(join(dir, "onboarding"), { recursive: true, mode: 0o700 });
	writeAtomic(inputPath(dir), `${JSON.stringify(input)}\n`, 0o600);
	chmodSync(inputPath(dir), 0o600);
}

export const webAccessFlow: OnboardFlow = {
	key: "web-access",
	steps: [
		{
			id: "cloudflared",
			title: "cloudflared 준비",
			detail: "이 컴퓨터에 cloudflared가 있는지 확인하고, 없으면 Homebrew로 설치해요.",
			owner: INSTALL_OWNER,
			run: async ctx => {
				if (await cloudflaredPath(ctx)) return { done: true };
				const brew = await ctx.deps.exec(["brew", "install", "cloudflared"]);
				if (await cloudflaredPath(ctx)) return { done: true };
				throw new Error(ctx.scrub(brew.code === 0 ? "cloudflared를 설치했지만 찾지 못했어요" : `cloudflared를 설치하지 못했어요: ${brew.out}`));
			},
		},
		{
			id: "login",
			title: "Cloudflare 로그인",
			detail: "인증서가 없으면 Cloudflare 로그인 화면을 배경 탭으로 열어요. 오너가 한 번 승인하면 cert.pem이 생겨요.",
			owner: LOGIN_OWNER,
			run: async ctx => {
				if (hasCert(ctx)) return { done: true };
				if (ctx.attempt > 0) return { waiting: LOGIN_OWNER };
				let url = "";
				const lines = ctx.deps.execLines;
				if (lines) {
					let sawUrl: (v: string) => void = () => {};
					let finished: () => void = () => {};
					const urlSeen = new Promise<string>(resolve => (sawUrl = resolve));
					const ended = new Promise<void>(resolve => (finished = resolve));
					const timeout = new Promise<void>(resolve => AbortSignal.timeout(15_000).addEventListener("abort", () => resolve(), { once: true }));
					void lines(["cloudflared", "tunnel", "login"], line => {
						if (url) return;
						const m = LOGIN_URL.exec(line);
						if (m) {
							url = ctx.seen(m[0]);
							sawUrl(url);
						}
					})
						.catch(() => undefined)
						.finally(finished);
					await Promise.race([urlSeen, ended, timeout]);
				} else {
					const r = await ctx.deps.exec(["cloudflared", "tunnel", "login"]);
					const m = LOGIN_URL.exec(r.out);
					if (m) url = ctx.seen(m[0]);
				}
				if (!url) throw new Error("Cloudflare 로그인 주소를 받지 못했어요");
				await ctx.deps.browser.run("cloudflare-login", { url });
				return hasCert(ctx) ? { done: true } : { waiting: LOGIN_OWNER };
			},
		},
		{
			id: "tunnel",
			title: "dotz 터널",
			detail: "dotz 이름의 터널을 다시 쓰고, 없으면 하나 만들어요.",
			owner: TUNNEL_OWNER,
			run: async ctx => {
				const list = await ctx.deps.exec(["cloudflared", "tunnel", "list", "--output", "json"]);
				if (tunnelNames(list.out).includes(TUNNEL)) return { done: true };
				const created = await ctx.deps.exec(["cloudflared", "tunnel", "create", TUNNEL]);
				if (created.code !== 0 && !/already exists|already created/i.test(created.out)) throw new Error(`Cloudflare 터널을 만들지 못했어요: ${ctx.scrub(created.out)}`);
				return { done: true };
			},
		},
		{
			id: "hostname",
			title: "주소 정하기",
			detail: "저장된 주소가 없으면 Cloudflare 계정의 첫 도메인에 dotz를 붙여요.",
			owner: ZONE_OWNER,
			run: async ctx => {
				const known = knownHostname(ctx) || ctx.memo.get("hostname") || "";
				if (known) {
					ctx.memo.set("hostname", known);
					return { done: true };
				}
				const got = await ctx.deps.browser.run("cloudflare-zone");
				if (got.waiting) return { waiting: ZONE_OWNER };
				if (!got.ok) throw new Error("Cloudflare 도메인을 찾지 못했어요");
				const zone = cleanHostname(got.value);
				if (!zone) throw new Error("Cloudflare 도메인을 읽지 못했어요");
				ctx.memo.set("hostname", `dotz.${zone}`);
				return { done: true };
			},
		},
		{
			id: "token",
			title: "DNS와 터널 토큰",
			detail: "dotz 터널에 주소를 연결하고, 터널 토큰을 이 컴퓨터의 secrets에만 저장해요.",
			owner: ROUTE_OWNER,
			run: async ctx => {
				const hostname = knownHostname(ctx) || ctx.memo.get("hostname") || "";
				if (!hostname) throw new Error("Cloudflare 주소를 찾지 못했어요");
				const routed = await ctx.deps.exec(["cloudflared", "tunnel", "route", "dns", TUNNEL, hostname]);
				const routedText = ctx.scrub(routed.out);
				if (routed.code !== 0 && !/already exists|already configured|already routes/i.test(routedText)) throw new Error(`터널 주소를 연결하지 못했어요: ${routedText}`);
				const read = await ctx.deps.exec(["cloudflared", "tunnel", "token", TUNNEL]);
				const token = tokenOf(read.out);
				if (!token) throw new Error("터널 토큰을 읽지 못했어요");
				ctx.seen(token);
				ctx.saveSecret(TOKEN_NAME, token);
				if (!ctx.deps.applyWebAccess) throw new Error("웹 접속을 적용할 수 없어요 (applyWebAccess가 연결되지 않았어요)");
				await ctx.deps.applyWebAccess({ mode: "cloudflare", hostname, token });
				ctx.memo.set("hostname", hostname);
				try {
					rmSync(inputPath(ctx.dir), { force: true });
				} catch {}
				ctx.changed();
				return { done: true };
			},
		},
		{
			id: "verify",
			title: "연결 확인",
			detail: "cloudflared에 dotz 터널이 보이는지 확인하고 웹 주소를 알려줘요.",
			owner: VERIFY_OWNER,
			run: async ctx => {
				const hostname = knownHostname(ctx) || ctx.memo.get("hostname") || "";
				if (!hostname) throw new Error("Cloudflare 주소를 찾지 못했어요");
				const info = await ctx.deps.exec(["cloudflared", "tunnel", "info", TUNNEL]);
				if (info.code !== 0) throw new Error(`터널을 확인하지 못했어요: ${ctx.scrub(info.out)}`);
				return { done: true, url: `https://${hostname}` };
			},
		},
	],
};
