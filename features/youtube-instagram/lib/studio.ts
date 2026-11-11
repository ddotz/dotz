// YouTube Studio upload as a fixed `aside repl` script (the deterministic replacement of the orchestrator driving the browser
// ad hoc). Used when the Google project is not audited, because the API locks such uploads to private and cannot set a related
// video. Two page steps, each run in its own background tab (openTab never focuses a window, the tab is closed in the same run,
// no Aside agent / `aside exec`), each ending in the PageResult states of lib/pages.ts:
//   1. `studio-upload`: the upload dialog, the file, wait until the upload is complete, read the video id, close the dialog
//      (a finished upload stays as a draft).
//   2. `studio-details`: the video's edit page: title, description, related video, visibility, then Save last. Nothing is
//      saved before every field was found, so a page this script does not know leaves the video untouched.
// The video id of step 1 is kept on the job, so a retry of step 2 never uploads the file twice. The tab has a 120 s repl limit:
// an upload that is not complete in about 100 s ends as `unexpected` and the orchestrator takes over (aside-needed).
import type { Ctx } from "./config.ts";
import { type PageResult, pageBody } from "./pages.ts";

export type Aside = { repl: (body: string) => Promise<unknown> };
export type Visibility = "private" | "unlisted" | "public";
export type StudioSpec = { file: string; title: string; description: string; visibility: Visibility; related?: string };
export type StudioOutcome = { state: PageResult["state"]; videoId?: string; note?: string };

export const studioUploadUrl = (channelId: string) => `https://studio.youtube.com/channel/${encodeURIComponent(channelId)}/videos/upload?d=ud`;
export const studioEditUrl = (videoId: string) => `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;

const UPLOAD_WAIT_MS = 100_000;
const NAME = { private: "PRIVATE", unlisted: "UNLISTED", public: "PUBLIC" } as const;

// Step 1. Ends ok with data.videoId; any other state leaves no tab behind (pageBody closes it) and no cancelled-looking success.
export const studioFileScript = (file: string): string => String.raw`
if (!(await dzWait("Upload videos|동영상 업로드|Select files|파일 선택", 30000))) return { state: "unexpected", note: "업로드 창이 열리지 않았어요" };
const input = pg.locator('input[type="file"]').first();
if (!(await input.count())) return { state: "unexpected", note: "파일을 고르는 칸을 찾지 못했어요" };
try { await input.setInputFiles(${JSON.stringify(file)}); } catch (e) { return { state: "unexpected", note: "파일을 넣지 못했어요" }; }
let id = null;
let done = false;
const end = Date.now() + ${UPLOAD_WAIT_MS};
while (Date.now() < end) {
  const text = await dzText();
  const m = /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|watch\?v=))([\w-]{11})/.exec(text);
  if (m) id = m[1];
  done = /Upload complete|Checks complete|Video upload complete|업로드 완료|검사가 완료|처리 중|Processing/i.test(text);
  if (id && done) break;
  await sleep(2000);
}
if (!id) return { state: "unexpected", note: "올린 영상의 주소를 읽지 못했어요" };
if (!done) return { state: "unexpected", note: "업로드가 시간 안에 끝나지 않았어요" };
await dzClick(["^(close|닫기)$"]);
await sleep(1500);
return { state: "ok", data: { videoId: id } };`;

// Step 2. Pure data in: the spec is embedded as JSON, never concatenated into code.
export const studioDetailsScript = (spec: Omit<StudioSpec, "file">): string => String.raw`
const S = ${JSON.stringify({ title: spec.title, description: spec.description, name: NAME[spec.visibility], related: spec.related ?? "" })};
if (!(await dzWait("Video details|동영상 세부정보|세부정보|Details", 30000))) return { state: "unexpected", note: "영상 편집 화면이 열리지 않았어요" };
await sleep(1500);
const setBox = async (sel, value) => {
  const box = pg.locator(sel).first();
  if (!(await box.count())) return false;
  await box.click();
  await box.fill(value);
  return true;
};
if (!(await setBox('#title-textarea [contenteditable="true"], #title-textarea #textbox', S.title))) return { state: "unexpected", note: "제목 칸을 찾지 못했어요" };
if (!(await setBox('#description-textarea [contenteditable="true"], #description-textarea #textbox', S.description))) return { state: "unexpected", note: "설명 칸을 찾지 못했어요" };
if (S.related) {
  await dzClick(["^(show more|자세히 보기|더보기)$"]);
  await sleep(800);
  if (!(await dzClick(["(related video|관련 동영상)"]))) return { state: "unexpected", note: "관련 동영상 항목을 찾지 못했어요" };
  await sleep(1500);
  const picked = await pg.evaluate((want) => {
    const w = want.toLowerCase();
    for (const el of document.querySelectorAll("ytcp-entity-card, [role=option], [role=row], tp-yt-paper-item, li")) {
      const t = (el.innerText || "").toLowerCase();
      if (t.includes(w) && el.offsetParent !== null) { el.setAttribute("data-dz-pick", "1"); return true; }
    }
    return false;
  }, S.related);
  if (!picked) return { state: "unexpected", note: "관련 동영상 후보에서 그 영상을 찾지 못했어요" };
  await pg.locator('[data-dz-pick="1"]').first().click();
  await pg.evaluate(() => document.querySelectorAll("[data-dz-pick]").forEach((e) => e.removeAttribute("data-dz-pick")));
  await sleep(500);
  if (!(await dzClick(["^(select|선택|done|완료)$"]))) return { state: "unexpected", note: "관련 동영상 선택 확인 버튼을 찾지 못했어요" };
  await sleep(800);
}
if (!(await dzClick(["^(private|unlisted|public|비공개|일부 공개|공개)\\b", "^(visibility|공개 상태)"]))) return { state: "unexpected", note: "공개 범위 버튼을 찾지 못했어요" };
await sleep(800);
const radio = pg.locator('[name="' + S.name + '"]').first();
if (!(await radio.count())) return { state: "unexpected", note: "공개 범위 선택지를 찾지 못했어요" };
await radio.click();
await dzClick(["^(done|완료)$"]);
await sleep(500);
if (!(await dzClick(["^(save|저장)$"]))) return { state: "unexpected", note: "저장 버튼을 찾지 못했어요" };
if (!(await dzWait("Changes saved|Saved|변경사항이 저장|저장됨", 30000))) return { state: "unexpected", note: "저장됐는지 확인하지 못했어요" };
return { state: "ok" };`;

const asResult = (v: unknown): PageResult => (v && typeof v === "object" && "state" in v ? (v as PageResult) : { state: "failed", note: "답이 비었어요" });
const note = (r: PageResult) => (r.note ?? "").replace(/\s+/g, " ").slice(0, 100);

// Runs both steps through the injected Aside runner. Never throws: an Aside failure is `failed` with its reason. `known` is the
// video id of an earlier run of this job (step 1 is skipped), `onVideo` stores a fresh one before step 2 starts.
export async function uploadViaStudio(aside: Aside, channelId: string, spec: StudioSpec, known: string | undefined, onVideo: (id: string) => void): Promise<StudioOutcome> {
	let videoId = known;
	try {
		if (!videoId) {
			const up = asResult(await aside.repl(pageBody("studio-upload", studioUploadUrl(channelId), studioFileScript(spec.file))));
			if (up.state !== "ok" || !up.data?.videoId) return { state: up.state === "ok" ? "failed" : up.state, note: note(up) || "영상 주소를 읽지 못했어요" };
			videoId = up.data.videoId;
			onVideo(videoId);
		}
		const det = asResult(await aside.repl(pageBody("studio-details", studioEditUrl(videoId), studioDetailsScript(spec))));
		if (det.state !== "ok") return { state: det.state, videoId, note: note(det) };
		return { state: "ok", videoId };
	} catch (e) {
		return { state: "failed", ...(videoId ? { videoId } : {}), note: (e instanceof Error ? e.message : "aside 오류").slice(0, 100) };
	}
}

export const realStudioAside = async (ctx: Ctx): Promise<Aside> => (await import("../bin/onboard.ts")).realAside(ctx);
