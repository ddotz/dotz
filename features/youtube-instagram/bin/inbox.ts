// Watch: new video files in the drop folder (local only, no network). Each new file is probed with ffprobe (through
// ctx.exec) and reported once as `new-video <path> <seconds>s <W>x<H> <vertical|landscape> <ok|too-long|not-vertical>`.
// Files touched in the last 30 s are skipped so a copy in progress is not probed; the first run records what is there.
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { type Ctx, SetupError } from "../lib/config.ts";
import { main, type RunResult, runWatch } from "../lib/watchkit.ts";

export const MAX_SECONDS = 180;
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const SETTLE_MS = 30_000;
const SEEN_CAP = 500;
type State = { seen: string[] };

type Probe = { seconds: number; width: number; height: number };
type FfprobeJson = { streams?: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string } };

async function probe(ctx: Ctx, file: string): Promise<Probe | undefined> {
	let res: Awaited<ReturnType<Ctx["exec"]>>;
	try {
		res = await ctx.exec(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", file], { timeoutMs: 30_000 });
	} catch {
		throw new SetupError("ffprobe is not installed");
	}
	if (res.code === 127) throw new SetupError("ffprobe is not installed");
	if (res.code !== 0) return undefined;
	let j: FfprobeJson;
	try {
		j = JSON.parse(res.stdout) as FfprobeJson;
	} catch {
		return undefined;
	}
	const s = j.streams?.[0];
	const duration = Number(j.format?.duration);
	if (!s?.width || !s.height || !Number.isFinite(duration)) return undefined;
	const rotation = Math.abs(Number(s.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0)) % 360;
	const turned = rotation === 90 || rotation === 270;
	return { seconds: Math.round(duration), width: turned ? s.height : s.width, height: turned ? s.width : s.height };
}

export const verdict = (p: Probe): "ok" | "too-long" | "not-vertical" => (p.seconds > MAX_SECONDS ? "too-long" : p.height > p.width ? "ok" : "not-vertical");

export async function run(ctx: Ctx, _args: string[] = []): Promise<RunResult> {
	return runWatch<State>(ctx, {
		body: async (cfg, prev) => {
			let names: string[];
			try {
				names = readdirSync(cfg.inbox_dir).sort();
			} catch {
				names = [];
			}
			const now = ctx.now().getTime();
			const files = names
				.filter(n => VIDEO_EXT.has(extname(n).toLowerCase()))
				.map(n => join(cfg.inbox_dir, n))
				.filter(f => {
					const st = statSync(f, { throwIfNoEntry: false });
					return st?.isFile() && now - st.mtimeMs >= SETTLE_MS;
				});
			const seen = new Set(prev?.seen ?? []);
			const lines: string[] = [];
			if (prev) {
				for (const f of files.filter(x => !seen.has(x))) {
					const p = await probe(ctx, f);
					if (!p) continue;
					lines.push(`new-video ${f} ${p.seconds}s ${p.width}x${p.height} ${p.height > p.width ? "vertical" : "landscape"} ${verdict(p)}`);
				}
			}
			const next = [...new Set([...(prev?.seen ?? []), ...files])].slice(-SEEN_CAP);
			return { lines, state: { seen: next } };
		},
	});
}

if (import.meta.main) await main(run);
