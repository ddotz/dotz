// YouTube Studio upload script: the two page steps run against a fake page (a screen table with buttons, a picker and a virtual
// clock, so no timers and no browser), plus the due.ts routing: unaudited projects use the script, audited ones keep the API,
// failures hand the job to the orchestrator after three tries or at once for a login page.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { hooks, run } from "../bin/due.ts";
import { paths, readJson } from "../lib/config.ts";
import { approve, getJob, newJob } from "../lib/jobs.ts";
import { type Aside, studioDetailsScript, studioEditUrl, studioFileScript, studioUploadUrl, uploadViaStudio } from "../lib/studio.ts";
import { pageBody } from "../lib/pages.ts";
import { CHANNEL, dropVideo, fakeCtx, setupEnv, type TestEnv } from "./helpers.ts";

type Screen = { text: string; buttons: Record<string, string>; cards?: string[]; locators?: string[] };

const VIDEO_ID = "abcdefghijk";
const SCREENS: Record<string, Screen> = {
	upload: { text: "Upload videos Select files", buttons: {}, locators: ['input[type="file"]'] },
	uploading: { text: `Uploading 40% https://youtu.be/${VIDEO_ID}`, buttons: {} },
	uploaded: { text: `Upload complete https://youtu.be/${VIDEO_ID}`, buttons: { Close: "closed" } },
	closed: { text: "Channel content", buttons: {} },
	edit: { text: "Video details Title Description", buttons: { "Show more": "more" }, locators: ["#title-textarea", "#description-textarea"] },
	more: { text: "Video details Related video", buttons: { "Related video": "picker", Private: "visibility", Save: "saved" }, locators: ["#title-textarea", "#description-textarea"] },
	picker: { text: "Select a video", buttons: { Select: "more" }, cards: ["Alpha video", "Beta video"] },
	visibility: { text: "Save or publish", buttons: { Done: "more" }, locators: ['[name="PRIVATE"]', '[name="UNLISTED"]', '[name="PUBLIC"]'] },
	saved: { text: "Changes saved", buttons: {} },
};

class FakeBrowser {
	opened: string[] = [];
	closed = 0;
	log: string[] = [];
	clock = 0;
	screen = "";
	url = "";
	marked: string | undefined;
	constructor(private flow: { start: Record<string, string>; uploadStays?: boolean; noPicker?: boolean }) {}

	private page() {
		const b = this;
		const cur = () => SCREENS[b.screen]!;
		const element = (label: string, kind: "button" | "card") => ({
			innerText: label,
			offsetParent: {},
			disabled: false,
			getAttribute: () => null,
			setAttribute: (n: string) => void (b.marked = `${kind}:${label}:${n}`),
			removeAttribute: () => void (b.marked = undefined),
		});
		const doc = {
			body: { get innerText() { return cur().text; } },
			querySelectorAll: (sel: string) => (sel.includes("ytcp-entity-card") ? (b.flow.noPicker ? [] : (cur().cards ?? []).map(c => element(c, "card"))) : sel.startsWith("[data-dz") ? [] : Object.keys(cur().buttons).map(x => element(x, "button"))),
		};
		const locator = (sel: string) => {
			const present = () => {
				if (sel.startsWith("[data-dz-click") || sel.startsWith("[data-dz-pick")) return b.marked ? 1 : 0;
				const hit = (cur().locators ?? []).some(l => sel.includes(l));
				return hit ? 1 : 0;
			};
			const self = {
				first: () => self,
				count: async () => present(),
				click: async () => {
					if (sel.startsWith("[data-dz-click")) {
						const label = b.marked!.split(":")[1]!;
						b.log.push(`click ${label}`);
						b.screen = cur().buttons[label]!;
					} else if (sel.startsWith("[data-dz-pick")) b.log.push(`pick ${b.marked!.split(":")[1]}`);
					else if (sel.startsWith("[name=")) b.log.push(`radio ${sel}`);
				},
				fill: async (v: string) => void b.log.push(`fill ${sel.includes("title") ? "title" : "description"}=${v}`),
				setInputFiles: async (f: string) => {
					b.log.push(`file ${f}`);
					b.screen = b.flow.uploadStays ? "uploading" : "uploaded";
				},
			};
			return self;
		};
		return {
			url: () => b.url,
			evaluate: async (fn: (a?: unknown) => unknown, arg?: unknown) => {
				(globalThis as any).document = doc;
				try {
					return fn(arg);
				} finally {
					delete (globalThis as any).document;
				}
			},
			locator,
		};
	}

	aside(): Aside {
		const Fn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
		return {
			repl: async body => {
				const pg = this.page();
				const openTab = async (url: string) => {
					this.opened.push(url);
					this.url = this.flow.start[url] === "login" ? "https://accounts.google.com/v3/signin" : url;
					this.screen = this.flow.start[url] === "login" ? "closed" : (this.flow.start[url] ?? (url.includes("/upload") ? "upload" : "edit"));
					return pg;
				};
				const closeTab = async () => void this.closed++;
				const sleep = async (ms: number) => void (this.clock += ms);
				const dateNow = { now: () => this.clock };
				return new Fn("openTab", "closeTab", "sleep", "fetch", "Date", body)(openTab, closeTab, sleep, async () => new Response(), dateNow);
			},
		};
	}
}

const spec = { file: "/videos/clip.mp4", title: "My title", description: "My description", visibility: "public" as const, related: "beta" };

test("both scripts are valid repl bodies", () => {
	const Fn = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
	for (const s of [studioFileScript(spec.file), studioDetailsScript(spec)]) expect(() => new Fn("openTab", "closeTab", "sleep", "fetch", pageBody("x", "https://studio.youtube.com", s))).not.toThrow();
});

test("upload, title, description, related video, visibility, then Save last; every tab is closed", async () => {
	const b = new FakeBrowser({ start: {} });
	const ids: string[] = [];
	const out = await uploadViaStudio(b.aside(), CHANNEL, spec, undefined, id => ids.push(id));
	expect(out).toEqual({ state: "ok", videoId: VIDEO_ID });
	expect(ids).toEqual([VIDEO_ID]);
	expect(b.opened).toEqual([studioUploadUrl(CHANNEL), studioEditUrl(VIDEO_ID)]);
	expect(b.closed).toBe(2);
	expect(b.log).toEqual([
		"file /videos/clip.mp4",
		"click Close",
		"fill title=My title",
		"fill description=My description",
		"click Show more",
		"click Related video",
		"pick Beta video",
		"click Select",
		"click Private",
		'radio [name="PUBLIC"]',
		"click Done",
		"click Save",
	]);
});

test("a retry with the known video id skips the upload step", async () => {
	const b = new FakeBrowser({ start: {} });
	const out = await uploadViaStudio(b.aside(), CHANNEL, spec, VIDEO_ID, () => {
		throw new Error("must not store again");
	});
	expect(out.state).toBe("ok");
	expect(b.opened).toEqual([studioEditUrl(VIDEO_ID)]);
	expect(b.log.some(l => l.startsWith("file "))).toBe(false);
});

test("an upload that does not finish in time ends unexpected, closes its tab and edits nothing", async () => {
	const b = new FakeBrowser({ start: {}, uploadStays: true });
	const out = await uploadViaStudio(b.aside(), CHANNEL, spec, undefined, () => {});
	expect(out).toMatchObject({ state: "unexpected", note: expect.stringContaining("시간 안에") });
	expect(b.closed).toBe(1);
	expect(b.opened).toEqual([studioUploadUrl(CHANNEL)]);
	expect(b.clock).toBeGreaterThanOrEqual(100_000);
});

test("a related video that is not in the picker stops before Save", async () => {
	const b = new FakeBrowser({ start: {}, noPicker: true });
	const out = await uploadViaStudio(b.aside(), CHANNEL, spec, VIDEO_ID, () => {});
	expect(out).toMatchObject({ state: "unexpected", videoId: VIDEO_ID });
	expect(b.log).not.toContain("click Save");
	expect(b.closed).toBe(1);
});

test("a Google login page is reported as owner and closes the tab", async () => {
	const b = new FakeBrowser({ start: { [studioUploadUrl(CHANNEL)]: "login" } });
	const out = await uploadViaStudio(b.aside(), CHANNEL, spec, undefined, () => {});
	expect(out.state).toBe("owner");
	expect(b.closed).toBe(1);
});

let env: TestEnv;
beforeEach(() => {
	env = setupEnv(c => {
		c.youtube!.upload_via = "api";
		c.youtube!.audited = undefined;
		delete c.instagram;
	});
});
afterEach(() => {
	hooks.aside = undefined;
	env.cleanup();
});

function scheduled(ctx: ReturnType<typeof fakeCtx>) {
	const file = dropVideo(env, "clip.mp4");
	const job = newJob(ctx, { kind: "upload", upload: { file, title: "T", description: "D", related: "beta" } });
	approve(ctx, job.id, { publish_at: "now" });
	return job.id;
}

test("an unaudited project uploads through Studio even with upload_via api; the job finishes and the file is filed away", async () => {
	const ctx = fakeCtx(env);
	const b = new FakeBrowser({ start: {} });
	hooks.aside = b.aside();
	const id = scheduled(ctx);
	const res = await run(ctx, []);
	expect(res.lines).toEqual([`posted ${id} youtube=${VIDEO_ID}`]);
	expect(getJob(id)).toMatchObject({ status: "done", result: { youtube: VIDEO_ID } });
	expect(ctx.calls.filter(c => c.url.includes("googleapis.com/upload"))).toHaveLength(0);
	expect(b.log).toContain("pick Beta video");
});

test("an audited project keeps the API upload", async () => {
	env.cleanup();
	env = setupEnv(c => {
		delete c.instagram;
	});
	const ctx = fakeCtx(env);
	ctx.routes["POST https://www.googleapis.com/upload/youtube/v3/videos"] = () => new Response("{}", { headers: { location: "https://upload.example/s1" } });
	ctx.routes["PUT https://upload.example/s1"] = () => ({ id: "vid1" });
	hooks.aside = { repl: async () => Promise.reject(new Error("Studio must not be used")) };
	hooks.reader = () => ({ size: 5, body: () => "VIDEO" });
	const id = scheduled(ctx);
	expect((await run(ctx, [])).lines).toEqual([`posted ${id} youtube=vid1`]);
	hooks.reader = undefined;
});

test("a failing script is retried twice silently, then handed to the orchestrator once; the video id is kept", async () => {
	const ctx = fakeCtx(env);
	const b = new FakeBrowser({ start: {}, noPicker: true });
	hooks.aside = b.aside();
	const id = scheduled(ctx);
	expect((await run(ctx, [])).lines).toEqual([]);
	expect((await run(ctx, [])).lines).toEqual([]);
	const third = await run(ctx, []);
	expect(third.lines).toEqual([`aside-needed ${id} youtube 관련 동영상 후보에서 그 영상을 찾지 못했어요`]);
	expect(getJob(id)).toMatchObject({ status: "scheduled", studio: { video_id: VIDEO_ID, tries: 3 } });
	expect(b.opened.filter(u => u.includes("/upload"))).toHaveLength(1);
	expect((await run(ctx, [])).lines).toEqual([]);
	expect(readJson(paths.config())).toBeTruthy();
});

test("a login page hands the job over at once", async () => {
	const ctx = fakeCtx(env);
	hooks.aside = new FakeBrowser({ start: { [studioUploadUrl(CHANNEL)]: "login" } }).aside();
	const id = scheduled(ctx);
	expect((await run(ctx, [])).lines).toEqual([`aside-needed ${id} youtube 구글 로그인 화면이 나왔어요`]);
});
