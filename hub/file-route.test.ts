// GET /api/file for the web chat's [file] chips: a file named in a [file] line of a sent message is served (also outside the
// lanes' folders, e.g. qa/ shots), and nothing else is: not an unattached neighbour, not a traversal, not secrets or the data dir's own files.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, sentFiles } from "./events.ts";
import { HUB_TOKEN } from "./config.ts";
import { allowedRoots, fileLinePaths, fileRoute } from "./files.ts";
import { makeRoute } from "./routes.ts";
import { bundle } from "./webapp.ts";

const DATA = process.env.DOTZ_DIR!;
const QA = join(DATA, "qa", "notice-arch");
mkdirSync(QA, { recursive: true });
mkdirSync(join(DATA, "secrets"), { recursive: true });
writeFileSync(join(QA, "notice-arch.png"), "PNGDATA");
writeFileSync(join(QA, "findings.md"), "# 결과");
writeFileSync(join(QA, "bundle.zip"), "ZIP");
writeFileSync(join(DATA, "secrets", "key.txt"), "s3cret");
writeFileSync(join(DATA, "config-copy.txt"), "not for the web");
writeFileSync(join(DATA, "..", "outside.txt"), "nope");

const sendFiles = (...paths: string[]) => emit("outbox", { ts: new Date().toISOString(), kind: "out", source: "orchestrator", target: "web", text: `결과\n${paths.map(p => `[file] ${p}`).join("\n")}` });
const get = (path: string, opts: { method?: string; dl?: boolean } = {}) => {
	const url = new URL(`http://x/api/file?path=${encodeURIComponent(path)}${opts.dl ? "&download=1" : ""}`);
	return fileRoute(new Request(url, { method: opts.method ?? "GET" }), url, allowedRoots([]), sentFiles());
};
const disposition = async (path: string, dl = false) => (await get(path, { dl })).headers.get("content-disposition") ?? "";

test("fileLinePaths reads [file] lines outside code fences", () => {
	expect(fileLinePaths("a\n[file] /x/a.png\n  [file] `qa/b.md`\n```\n[file] /in/fence\n```")).toEqual(["/x/a.png", "qa/b.md"]);
});

test("a file named in a sent [file] line is served; before the message it is refused", async () => {
	const png = join(QA, "late.png");
	writeFileSync(png, "PNGDATA");
	expect((await get(png)).status).toBe(403);
	sendFiles(png, join(QA, "findings.md"), join(QA, "bundle.zip"), join(DATA, "secrets", "key.txt"), join(DATA, "config-copy.txt"), "~/no-such-dir/x.png", "qa/notice-arch/findings.md", "../outside.txt");
	const ok = await get(png);
	expect(ok.status).toBe(200);
	expect(ok.headers.get("content-type")).toBe("image/png");
	expect(await ok.text()).toBe("PNGDATA");
	expect((await get(png, { method: "HEAD" })).headers.get("content-length")).toBe("7");
	expect(await disposition(png)).toStartWith("inline;");
	expect(await disposition(join(QA, "findings.md"))).toStartWith('inline; filename="findings.md"');
	expect(await disposition(join(QA, "bundle.zip"))).toStartWith("attachment;");
	expect(await disposition(png, true)).toStartWith("attachment;");
});

test("a relative [file] line resolves under the data dir", async () => {
	sendFiles("qa/notice-arch/findings.md");
	expect(await (await get("qa/notice-arch/findings.md")).text()).toBe("# 결과");
});

test("a listed file is still refused when it is a secret, a data dir file, missing or a relative path with ..", async () => {
	sendFiles(join(DATA, "secrets", "key.txt"), join(DATA, "config-copy.txt"), "~/no-such-dir/x.png", "../outside.txt");
	expect((await get(join(DATA, "secrets", "key.txt"))).status).toBe(403);
	expect((await get(join(DATA, "config-copy.txt"))).status).toBe(403);
	expect((await get("~/no-such-dir/x.png")).status).toBe(404);
	expect((await get("../outside.txt")).status).toBe(400);
	expect((await get("")).status).toBe(400);
});

test("a file that was never attached is refused, also by traversal from an attached one", async () => {
	sendFiles(join(QA, "notice-arch.png"));
	writeFileSync(join(QA, "other.png"), "x");
	expect((await get(join(QA, "other.png"))).status).toBe(403);
	expect((await get(join(QA, "..", "..", "..", "..", "..", "..", "..", "..", "..", "..", "..", "etc", "hosts"))).status).toBe(403);
	// a plain temp file beside the data dir is not data: it opens (hub/file-snapshot.test.ts)
	expect((await get(join(DATA, "..", "outside.txt"))).status).toBe(200);
});

test("a listed work-channel result under projects/ is served; an unlisted neighbour in the same folder is refused", async () => {
	const dir = join(DATA, "projects", "cartier");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "shot.png"), "PROJPNG");
	writeFileSync(join(dir, "unlisted.png"), "x");
	sendFiles("projects/cartier/shot.png");
	const ok = await get("projects/cartier/shot.png");
	expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, "image/png", "PROJPNG"]);
	expect((await get(join(dir, "unlisted.png"))).status).toBe(403);
});

// A computer in the app's switcher (맥미니) is a gateway of its own: the page opens on its origin and asks that gateway's /api/file, with the same
// auth as every other call. So a [file] line its bot sent is served through the full route, and refused without the login.
test("a peer gateway's sent [file] image is served through the whole route, and only with the auth", async () => {
	const shot = join(DATA, "..", "peer-shot.png");
	writeFileSync(shot, "PEERPNG");
	sendFiles(shot);
	const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const url = `http://mini.tailnet.ts.net/api/file?path=${encodeURIComponent(shot)}`;
	expect((await route(new Request(url))).status).toBe(403);
	const ok = await route(new Request(url, { headers: { "x-dotz-token": HUB_TOKEN } }));
	expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, "image/png", "PEERPNG"]);
	const head = await route(new Request(url, { method: "HEAD", headers: { "x-dotz-token": HUB_TOKEN } }));
	expect([head.status, head.headers.get("content-length")]).toEqual([200, "7"]);
});

test("a notice sheet keeps the files of its [file] lines as chips next to the text", () => {
	const js = bundle("js").text;
	const grab = (re: RegExp) => re.exec(js)?.[0] ?? "";
	const fn = new Function("mdNode", "filesNode", `${grab(/function fileLines\(text\) \{[\s\S]*?\n\}\n/)}\n${grab(/function ntBody\(n, text\) \{[\s\S]*?\n\}\n/)}\n${grab(/function ntCode\(text\) \{[\s\S]*?\n\}\n/)}\nreturn ntBody;`)((t: string) => ({ md: t }), (f: { path: string }[]) => (f.length ? { files: f.map(x => x.path) } : null));
	expect(fn({ text: "맥미니 결과\n[file] /Users/x/shot.png\n[file] /Users/x/report.pdf" })).toEqual([{ md: "맥미니 결과" }, { files: ["/Users/x/shot.png", "/Users/x/report.pdf"] }]);
	expect(fn({ text: "파일 없음" })).toEqual([{ md: "파일 없음" }, null]);
});

test("the web turns [file] lines into chips, keeps them out of notice text and has the reader", () => {
	const js = bundle("js").text;
	const grab = (re: RegExp) => re.exec(js)?.[0] ?? "";
	const fn = new Function(`${grab(/const MK_BODY[\s\S]*?\nfunction stripMarkers[\s\S]*?\n\}\n/)}\n${grab(/function fileLines\(text\) \{[\s\S]*?\n\}\n/)}\n${grab(/const ntPlain = [\s\S]*?\.trim\(\);/)}\nreturn { fileLines, ntPlain };`)();
	const r = fn.fileLines("결과\n[file] /a/b/notice-arch.png\n[file] qa/findings.md\n```\n[file] /in/fence\n```");
	expect(r.files.map((x: { name: string }) => x.name)).toEqual(["notice-arch.png", "findings.md"]);
	expect(r.text).toContain("[file] /in/fence");
	expect(fn.ntPlain("끝났어요\n[file] /a/b.png")).toBe("끝났어요");
	expect(js).toContain("async function viewer(path, name, pc)");
});
