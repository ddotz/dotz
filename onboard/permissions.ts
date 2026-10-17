// macOS permissions the gateway needs, asked once during onboarding (`bun setup.ts permissions`, `--check`).
// The gateway is a launchd agent whose program is bun, so for launchd bun is the TCC "responsible process": every protected
// access by the gateway or anything it spawns (omp lanes, orchestrator, osascript, aside, git) prompts as "bun". A check run
// from a terminal would be attributed to the terminal app instead, so both probes run as a short launchd job whose program
// is the same bun binary (this file with --probe). Check mode never raises a dialog (TCCAccessPreflight, AE with ask=false);
// request mode reads the not-yet-asked folders and asks for Automation, which raises the real prompts attributed to bun.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const PROBE_LABEL = "dev.dotz.permprobe";
const GATEWAY_LABEL = "dev.dotz.gateway";
const GATEWAY_PLIST = join(HOME, "Library", "LaunchAgents", `${GATEWAY_LABEL}.plist`);
const SYSTEM_EVENTS = "com.apple.systemevents";
const PANE = "x-apple.systempreferences:com.apple.preference.security?";

export type Status = "granted" | "missing" | "unknown";
// Internal states keep "denied" (the owner turned it off, no prompt will come back) apart from "notasked" (a prompt can still appear).
type Detail = "granted" | "denied" | "notasked" | "unknown";
type Details = Record<string, Detail>;

export type Permission = {
	key: string;
	label: string;
	/** TCC service name (kTCCService...) checked with TCCAccessPreflight; absent for Automation. */
	service?: string;
	/** Bundle id of the Automation target. */
	ae?: string;
	/** Folder (under ~) whose readdir raises the prompt. */
	folder?: string;
	/** "prompt": the system raises a dialog when the probe job touches it. "pane": only the Settings pane can grant it. */
	how: "prompt" | "pane";
	pane: string;
	/** Counts as granted when Full Disk Access is granted. */
	viaFda?: boolean;
	evidence: string;
};

export const PERMISSIONS: Permission[] = [
	{
		key: "fda", label: "전체 디스크 접근", service: "kTCCServiceSystemPolicyAllFiles", how: "pane", pane: `${PANE}Privacy_AllFiles`,
		evidence: "레인과 오케스트레이터는 임의 폴더에서 omp 를 띄워 파일을 읽어요 (hub/lanes.ts spawn, hub/orchestrator.ts). 데스크탑·문서·다운로드·iCloud·외장·네트워크 볼륨을 한 번에 해결해요. 팝업이 없어서 설정 창에서 켜요.",
	},
	{
		key: "desktop", label: "파일 및 폴더: 데스크탑", service: "kTCCServiceSystemPolicyDesktopFolder", folder: "Desktop", how: "prompt", pane: `${PANE}Privacy_FilesAndFolders`, viaFda: true,
		evidence: "전체 디스크 접근이 있으면 충족. 없으면 프로브 작업이 폴더를 읽어 팝업을 띄워요.",
	},
	{
		key: "documents", label: "파일 및 폴더: 문서", service: "kTCCServiceSystemPolicyDocumentsFolder", folder: "Documents", how: "prompt", pane: `${PANE}Privacy_FilesAndFolders`, viaFda: true,
		evidence: "전체 디스크 접근이 있으면 충족. 없으면 프로브 작업이 폴더를 읽어 팝업을 띄워요.",
	},
	{
		key: "downloads", label: "파일 및 폴더: 다운로드", service: "kTCCServiceSystemPolicyDownloadsFolder", folder: "Downloads", how: "prompt", pane: `${PANE}Privacy_FilesAndFolders`, viaFda: true,
		evidence: "전체 디스크 접근이 있으면 충족. 없으면 프로브 작업이 폴더를 읽어 팝업을 띄워요.",
	},
	{
		key: "removable", label: "이동식 볼륨", service: "kTCCServiceSystemPolicyRemovableVolumes", how: "pane", pane: `${PANE}Privacy_AllFiles`, viaFda: true,
		evidence: "전체 디스크 접근이 있으면 충족. 팝업은 그 볼륨이 실제로 마운트됐을 때만 떠서 전체 디스크 접근으로 해결해요.",
	},
	{
		key: "network", label: "네트워크 볼륨", service: "kTCCServiceSystemPolicyNetworkVolumes", how: "pane", pane: `${PANE}Privacy_AllFiles`, viaFda: true,
		evidence: "전체 디스크 접근이 있으면 충족. 팝업은 그 볼륨이 실제로 마운트됐을 때만 떠서 전체 디스크 접근으로 해결해요.",
	},
	{
		key: "automation", label: "자동화: System Events", ae: SYSTEM_EVENTS, how: "prompt", pane: `${PANE}Privacy_Automation`,
		evidence: "hub/watch.ts 가 osascript 'tell application \"System Events\"' 로 맨 앞 앱을 확인해요. AEDeterminePermissionToAutomateTarget 으로 팝업을 띄워요.",
	},
	{
		key: "accessibility", label: "손쉬운 사용", service: "kTCCServiceAccessibility", how: "pane", pane: `${PANE}Privacy_Accessibility`,
		evidence: "MODE.md 의 OS 수준 키 입력(System Events keystroke). 팝업이 없어서 설정 창에서 켜요.",
	},
];
// Not needed (no code path): Screen Recording, Local Network, Notifications, Contacts, Calendars.

const publicStatus = (d: Detail): Status => (d === "granted" ? "granted" : d === "unknown" ? "unknown" : "missing");

const realBun = (bun: string) => {
	try {
		return realpathSync(bun);
	} catch {
		return bun;
	}
};

// TCCAccessPreflight / AEDeterminePermissionToAutomateTarget return codes.
const mapCode = (c: number): Detail => (c === 0 ? "granted" : c === 1 || c === -1743 ? "denied" : c === 2 || c === -1744 ? "notasked" : "unknown");

// Runs inside the launchd job. Writes the JSON result to outFile, atomically.
async function runProbe(mode: string, outFile: string, keys: string[]): Promise<void> {
	const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
		CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
	});
	const tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", {
		TCCAccessPreflight: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const ae = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", {
		AECreateDesc: { args: [FFIType.u32, FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.i16 },
		AEDeterminePermissionToAutomateTarget: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.bool], returns: FFIType.i32 },
		AEDisposeDesc: { args: [FFIType.ptr], returns: FFIType.i16 },
	});
	const code = (s: string) => Buffer.from(s, "latin1").readUInt32BE(0);
	const preflight = (service: string) =>
		tcc.symbols.TCCAccessPreflight(cf.symbols.CFStringCreateWithCString(null, ptr(Buffer.from(`${service}\0`)), 0x08000100), null);
	const automation = (bundle: string, askUser: boolean) => {
		const desc = new Uint8Array(16);
		const id = Buffer.from(bundle);
		ae.symbols.AECreateDesc(code("bund"), ptr(id), id.length, ptr(desc));
		const r = ae.symbols.AEDeterminePermissionToAutomateTarget(ptr(desc), code("****"), code("****"), askUser);
		ae.symbols.AEDisposeDesc(ptr(desc));
		return r;
	};
	const finish = (result: unknown) => {
		writeFileSync(`${outFile}.tmp`, JSON.stringify(result));
		renameSync(`${outFile}.tmp`, outFile);
	};

	// System Events must be running for the Automation check (-600 otherwise); start it in the background, no window.
	Bun.spawnSync(["open", "-g", "-j", "-b", SYSTEM_EVENTS]);
	for (let i = 0; i < 25 && automation(SYSTEM_EVENTS, false) === -600; i++) await Bun.sleep(200);

	if (mode === "request") {
		for (const p of PERMISSIONS) {
			if (!keys.includes(p.key)) continue;
			if (p.folder) {
				try {
					readdirSync(join(HOME, p.folder));
				} catch {}
			} else if (p.ae) automation(p.ae, true);
		}
		return finish({});
	}

	const result: Details = {};
	for (const p of PERMISSIONS) {
		if (p.service) result[p.key] = mapCode(preflight(p.service));
		else if (p.ae) result[p.key] = mapCode(automation(p.ae, false));
	}
	for (const p of PERMISSIONS) if (p.viaFda && result.fda === "granted") result[p.key] = "granted";
	finish(result);
}

// Runs the probe as a launchd job and returns its JSON, or undefined when it did not answer within timeoutMs.
async function launch(bun: string, mode: "check" | "request", keys: string[], timeoutMs: number): Promise<Details | undefined> {
	const uid = process.getuid?.() ?? 501;
	const domain = `gui/${uid}/${PROBE_LABEL}`;
	const dir = mkdtempSync(join(tmpdir(), "dotz-permprobe-"));
	const outFile = join(dir, "result.json");
	const plistFile = join(dir, `${PROBE_LABEL}.plist`);
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const argv = [bun, import.meta.path, "--probe", mode, outFile, ...(keys.length ? [keys.join(",")] : [])];
	writeFileSync(
		plistFile,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PROBE_LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map(a => `<string>${esc(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(join(dir, "probe.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(dir, "probe.log"))}</string>
</dict></plist>
`,
	);
	try {
		await Bun.$`launchctl bootout ${domain}`.nothrow().quiet();
		let r = await Bun.$`launchctl bootstrap gui/${uid} ${plistFile}`.nothrow().quiet();
		for (let i = 0; i < 5 && r.exitCode !== 0; i++) {
			await Bun.sleep(1000);
			r = await Bun.$`launchctl bootstrap gui/${uid} ${plistFile}`.nothrow().quiet();
		}
		if (r.exitCode !== 0) return undefined;
		for (const end = Date.now() + timeoutMs; Date.now() < end; await Bun.sleep(200)) {
			if (existsSync(outFile)) return JSON.parse(readFileSync(outFile, "utf8")) as Details;
		}
		return undefined;
	} finally {
		await Bun.$`launchctl bootout ${domain}`.nothrow().quiet();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function detail(bun: string): Promise<Details> {
	return (await launch(bun, "check", [], 20_000)) ?? Object.fromEntries(PERMISSIONS.map(p => [p.key, "unknown" as Detail]));
}

const toStatus = (d: Details): Record<string, Status> => Object.fromEntries(PERMISSIONS.map(p => [p.key, publicStatus(d[p.key] ?? "unknown")]));

export async function checkPermissions(bun: string): Promise<Record<string, Status>> {
	return toStatus(await detail(realBun(bun)));
}

/** One line per permission: `<label padded>  granted|missing|unknown  <bun path>`. */
export function printPermissions(bun: string, status: Record<string, Status>): void {
	const path = realBun(bun);
	// Hangul and other wide characters take two terminal columns.
	const width = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0);
	const pad = Math.max(...PERMISSIONS.map(p => width(p.label)));
	for (const p of PERMISSIONS) {
		console.log(`${p.label}${" ".repeat(pad - width(p.label))}  ${status[p.key] ?? "unknown"}  ${path}${p.ae ? ` -> ${p.ae}` : ""}`);
	}
}

/** Interactive flow: prompts for what can prompt, then walks the Settings panes for the rest, re-checking after each Enter. */
export async function requestPermissions(bun: string, ask: (q: string) => string): Promise<void> {
	bun = realBun(bun);
	console.log("권한을 확인하는 중...");
	const before = await detail(bun);
	let now = before;
	printPermissions(bun, toStatus(before));
	if (!process.stdin.isTTY) return void console.log("터미널이 아니라서 권한 요청은 건너뛰어요. 터미널에서 bun setup.ts permissions 를 실행하세요.");

	const askable = PERMISSIONS.filter(p => p.how === "prompt" && now[p.key] === "notasked");
	if (askable.length) {
		console.log(`곧 팝업이 떠요. '허용'을 눌러 주세요: ${askable.map(p => p.label).join(", ")}`);
		await launch(bun, "request", askable.map(p => p.key), 180_000);
		now = await detail(bun);
	}

	// Full Disk Access comes first: once it is granted the folder entries resolve with it. Volumes only ever resolve through it.
	for (const p of PERMISSIONS.filter(p => !(p.viaFda && p.how === "pane"))) {
		while (now[p.key] !== "granted") {
			await Bun.$`open ${p.pane}`.nothrow().quiet();
			console.log(
				p.ae
					? `${p.label}: 시스템 설정 창이 열렸어요. bun 아래의 System Events 를 켜 주세요 (${bun})`
					: `${p.label}: 시스템 설정 창이 열렸어요. 목록에서 bun 을 켜 주세요. 없으면 + 로 추가: ${bun} (파일 선택 창에서 Cmd+Shift+G 를 누르고 숨김 폴더 ~/.bun 경로를 붙여넣어요)`,
			);
			if (ask("켠 다음 Enter, 건너뛰려면 s").toLowerCase() === "s") break;
			now = await detail(bun);
		}
	}

	console.log("\n최종 상태:");
	printPermissions(bun, toStatus(now));
	const changed = PERMISSIONS.some(p => before[p.key] !== "granted" && now[p.key] === "granted");
	if (changed && existsSync(GATEWAY_PLIST)) {
		console.log(`새 권한은 게이트웨이를 다시 시작해야 적용돼요: launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${GATEWAY_LABEL}`);
	}
}

const probeArgs = process.argv.slice(2);
if (import.meta.main && probeArgs[0] === "--probe") await runProbe(probeArgs[1], probeArgs[2], (probeArgs[3] ?? "").split(",").filter(Boolean));
