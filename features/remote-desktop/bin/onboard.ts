// Turns the remote desktop on (features/remote-desktop/DESIGN.md): macOS only; builds a pinned voxl on this computer, enables the shipped
// feature, then asks the running gateway for the screen-recording permission and a read-only trial.
// bun <dotz>/features/remote-desktop/bin/onboard.ts [--control] [--rebuild] [--status]
// Exit 0 done, 3 the owner has one step to do (printed), 1 failed (reason printed). Run again to resume: finished steps are skipped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { liveGateway, type Gateway } from "../../webmail-no-api/lib/gateway.ts";

export const PIN = "eba3b7ced9f60e885bb7b3a96a12e3ccb347fdcd";
const VOXL_GIT = "https://github.com/tembo/voxl";
const BREW_DEPS = ["x264", "opus", "pkg-config"];
const STEPS = ["preflight", "deps", "build", "link", "enable", "gateway", "permissions", "trial"] as const;
type Step = (typeof STEPS)[number];

export type Exec = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type Io = {
	platform: NodeJS.Platform;
	dataDir: string;
	repo: string;
	exec: Exec;
	which(bin: string): boolean;
	read(file: string): string | undefined;
	write(file: string, text: string): void;
	gateway: Gateway;
	say(line: string): void;
};
export type Flags = { control?: boolean; rebuild?: boolean };
export type Result = { code: 0 | 1 | 3; status: "done" | "waiting" | "failed"; step?: Step };
type Saved = { done: Step[]; control?: boolean };

const rootOf = (io: Io) => join(io.dataDir, "remote-desktop");
const binOf = (io: Io) => join(rootOf(io), "bin", "voxl");
const json = (s: string | undefined): any => {
	try {
		return s ? JSON.parse(s) : undefined;
	} catch {
		return undefined;
	}
};

export async function runOnboard(io: Io, flags: Flags): Promise<Result> {
	const stateFile = join(rootOf(io), "onboard.json");
	const saved: Saved = { done: [], ...json(io.read(stateFile)) };
	if (flags.rebuild) saved.done = saved.done.filter(s => s !== "build" && s !== "link");
	const fail = (step: Step, why: string): Result => (io.say(why), { code: 1, status: "failed", step });
	const done = (step: Step) => {
		if (!saved.done.includes(step)) saved.done.push(step);
		io.write(stateFile, JSON.stringify(saved));
	};
	const linked = async () => {
		const r = await io.exec([binOf(io), "--help"]);
		return { ok: r.code === 0, dyld: /dyld|Library not loaded/i.test(`${r.stdout}${r.stderr}`) };
	};
	const build = async (): Promise<boolean> => {
		io.say("voxl을 이 컴퓨터에서 빌드해요 (몇 분 걸려요)");
		return (await io.exec(["cargo", "install", "--git", VOXL_GIT, "--rev", PIN, "--locked", "--root", rootOf(io), "--force"])).code === 0;
	};

	if (io.platform !== "darwin") return fail("preflight", `화면 공유는 macOS에서만 돼요 (${io.platform}에서는 켜지 않아요: voxl이 화면을 잡는 방식이 macOS 전용이에요)`);
	if (!io.which("brew")) return fail("preflight", "Homebrew가 필요해요 (https://brew.sh). 설치한 뒤 같은 명령을 다시 돌려요");

	if (!saved.done.includes("deps") && !flags.rebuild) {
		const need = [];
		for (const name of BREW_DEPS) if ((await io.exec(["brew", "list", "--formula", name])).code !== 0) need.push(name);
		if (!io.which("cargo")) need.push("rust");
		if (need.length && (await io.exec(["brew", "install", ...need])).code !== 0) return fail("deps", `brew install ${need.join(" ")}가 실패했어요`);
		if (!io.which("esbuild") && (await io.exec(["bun", "add", "-g", "esbuild"])).code !== 0) return fail("deps", "bun add -g esbuild가 실패했어요");
		done("deps");
	}

	if (!saved.done.includes("build")) {
		const same = io.read(join(rootOf(io), ".crates.toml"))?.includes(PIN) && (await linked()).ok;
		if (!same && !(await build())) return fail("build", "voxl 빌드가 실패했어요. 위 cargo 출력의 마지막 줄을 확인하고 같은 명령을 다시 돌려요");
		done("build");
	}

	if (!saved.done.includes("link")) {
		let l = await linked();
		// A brew upgrade can move libx264 under a built binary: rebuilt once, then it must run.
		if (!l.ok && l.dyld) {
			io.say("voxl이 라이브러리를 못 찾아요 (brew 업그레이드 뒤에 흔해요). 다시 빌드해요");
			if (await build()) l = await linked();
		}
		if (!l.ok) return fail("link", "voxl이 실행되지 않아요. brew install x264 opus로 라이브러리를 확인하고 같은 명령을 다시 돌려요");
		done("link");
	}
	if (flags.rebuild) return io.say("다시 빌드했어요"), { code: 0, status: "done" };

	// The shipped text stays the shipped one: a personal copy only switches it on (hub/featuredirs.ts).
	const shipped = io.read(join(io.repo, "features", "remote-desktop", "feature.md"));
	if (!shipped) return fail("enable", "features/remote-desktop/feature.md가 없어요");
	io.write(join(io.dataDir, "features", "remote-desktop", "feature.md"), shipped.replace(/^enabled: false$/m, "enabled: true"));
	const prev = json(io.read(join(rootOf(io), "settings.json"))) ?? {};
	const control = flags.control ?? saved.control ?? prev.control === true;
	saved.control = control;
	io.write(join(rootOf(io), "settings.json"), JSON.stringify({ on: true, control, allow_public: prev.allow_public === true }));
	done("enable");

	try {
		const st = await io.gateway("GET", "/api/desk/status");
		if (st?.available !== true) return fail("gateway", "켜졌지만 실행 중인 게이트웨이가 아직 이 기능을 몰라요. 게이트웨이를 다시 시작한 뒤 같은 명령을 다시 돌려요");
	} catch (e) {
		return fail("gateway", `${(e as Error).message}. 게이트웨이를 켠 뒤 같은 명령을 다시 돌려요`);
	}

	// Asked from the gateway's own process: macOS ties the permission to the program that asks, never to a terminal.
	const perm = await io.gateway("POST", "/api/desk/probe", { grant: true }).catch(e => ({ error: (e as Error).message }));
	if (perm.error) return fail("permissions", `권한 확인이 실패했어요: ${perm.error}`);
	if (!perm.screen || (control && !perm.accessibility)) {
		io.say(perm.step ?? `시스템 설정 > 개인정보 보호 및 보안 > ${perm.screen ? "손쉬운 사용" : "화면 기록"}에서 bun을 켜 주세요`);
		io.say("켠 뒤 같은 명령을 다시 돌려요");
		return { code: 3, status: "waiting", step: "permissions" };
	}

	if (!saved.done.includes("trial")) {
		const t = await io.gateway("POST", "/api/desk/probe", { trial: true }).catch(e => ({ ok: false, error: (e as Error).message }));
		if (!t.ok) return fail("trial", `화면 시험이 실패했어요${t.error ? `: ${t.error}` : t.bytes !== undefined ? ` (${t.bytes}바이트)` : ""}`);
		done("trial");
	}
	io.say(`화면 공유를 켰어요 (${control ? "조작 허용" : "보기만"}). 다른 컴퓨터의 앱에서 이 컴퓨터를 고르고 화면 공유를 열어요`);
	return { code: 0, status: "done" };
}

function liveIo(): Io {
	const dataDir = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
	return {
		platform: process.platform,
		dataDir,
		repo: join(import.meta.dir, "..", "..", ".."),
		exec: async argv => {
			const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			return { code: await proc.exited, stdout, stderr };
		},
		which: bin => !!Bun.which(bin),
		read: file => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
		write: (file, text) => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(`${file}.tmp`, text);
			renameSync(`${file}.tmp`, file);
		},
		gateway: liveGateway,
		say: line => console.log(line),
	};
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const io = liveIo();
	if (argv.includes("--status")) {
		const saved = json(io.read(join(rootOf(io), "onboard.json")));
		console.log(saved ? `끝난 단계: ${(saved.done as Step[]).join(", ") || "없음"}` : "화면 공유를 켠 적이 없어요");
		process.exit(0);
	}
	const res = await runOnboard(io, { rebuild: argv.includes("--rebuild"), ...(argv.includes("--control") ? { control: true } : {}) });
	console.log(`REMOTE_DESKTOP_ONBOARD ${res.status}${res.step ? ` ${res.step}` : ""}`);
	process.exit(res.code);
}
