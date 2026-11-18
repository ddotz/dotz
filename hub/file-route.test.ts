// GET /api/file for the web chat's [file] chips: a file named in a [file] line of a sent message is served (also outside the
// lanes' folders, e.g. qa/ shots), and nothing else is: not an unattached neighbour, not a traversal, not secrets or the data dir's own files.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, sentFiles } from "./events.ts";
import { listedFileRoute } from "./listed-files.ts";
import { upsert } from "./notices-store.ts";
import { HUB_TOKEN } from "./config.ts";
import { allowedRoots, fileLinePaths, fileRoute } from "./files.ts";
import { makeRoute } from "./routes.ts";
import { ev, fakeHub, waitFor } from "./test-web.ts";

const hub = fakeHub();
afterAll(() => hub.stop());
const view = await hub.view({}, "/");
await waitFor(view, `typeof ntBody === "function" && typeof fileLines === "function" && S`);

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
	const dir = join(DATA, "projects", "boutique");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "shot.png"), "PROJPNG");
	writeFileSync(join(dir, "unlisted.png"), "x");
	sendFiles("projects/boutique/shot.png");
	const ok = await get("projects/boutique/shot.png");
	expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, "image/png", "PROJPNG"]);
	expect((await get(join(dir, "unlisted.png"))).status).toBe(403);
});

// A result chip is the gateway's own claim that a file is the job's result, so its path opens (a stored notice's files, a done work row's files);
// a neighbour no chip names, and anything DENY or the private folders refuse, stay refused.
const chipGet = (path: string, rows: { files?: { path: string }[] }[] = []) => {
	const url = new URL(`http://x/api/file?path=${encodeURIComponent(path)}`);
	return listedFileRoute(new Request(url), url, allowedRoots([]), () => rows);
};
const chipFile = (path: string) => ({ path, name: path.split("/").pop()!, size: 1 });
const findings = join(DATA, "projects", "p", "findings");
mkdirSync(findings, { recursive: true });
for (const f of ["a.md", "b.md", "c.md", "d.md"]) writeFileSync(join(findings, f), `body ${f}`);

test("a file on a stored notice's chip is served; an unnamed neighbour is refused", async () => {
	expect((await chipGet(join(findings, "a.md"))).status).toBe(403);
	upsert({ kind: "result", tone: "", title: "결과", text: "끝났어요", open: "lane:p", key: "lane:p", files: [chipFile(join(findings, "a.md"))] });
	const ok = await chipGet(join(findings, "a.md"));
	expect([ok.status, await ok.text()]).toEqual([200, "body a.md"]);
	expect((await chipGet(join(findings, "b.md"))).status).toBe(403);
});

test("a file on a done work row's chip is served; an unnamed neighbour is refused", async () => {
	const rows = [{ files: [chipFile(join(findings, "c.md"))] }];
	expect((await chipGet(join(findings, "c.md"))).status).toBe(403);
	const ok = await chipGet(join(findings, "c.md"), rows);
	expect([ok.status, await ok.text()]).toEqual([200, "body c.md"]);
	expect((await chipGet(join(findings, "d.md"), rows)).status).toBe(403);
});

test("a chip naming a secret or a DENY path is still refused", async () => {
	const secret = join(DATA, "secrets", "key.txt"), env = join(findings, ".env");
	writeFileSync(env, "K=v");
	upsert({ kind: "result", tone: "", title: "비밀", text: "끝났어요", open: "lane:q", key: "lane:q", files: [chipFile(secret), chipFile(env)] });
	const rows = [{ files: [chipFile(secret), chipFile(env)] }];
	expect((await chipGet(secret, rows)).status).toBe(403);
	expect((await chipGet(env, rows)).status).toBe(403);
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

test("a notice sheet keeps the files of its [file] lines as chips next to the text", async () => {
	const body = (text: string) => ev<{ cls: string; text: string }[]>(view, `ntBody({ text: ${JSON.stringify(text)} }).map(p => ({ cls: p.className, text: p.textContent }))`);
	const [md, ...files] = await body("맥미니 결과\n[file] /work/shot.png\n[file] /work/report.pdf");
	expect(md!.text).toBe("맥미니 결과");
	expect(files.map(f => f.text).join(" ")).toContain("shot.png");
	expect(files.map(f => f.text).join(" ")).toContain("report.pdf");
	expect(files.map(f => f.text).join(" ")).not.toContain("[file]");
	expect(await body("파일 없음")).toEqual([{ cls: "md ds-md", text: "파일 없음" }]);
});

test("the web turns [file] lines into chips and keeps them out of notice text", async () => {
	const r = await ev<{ names: string[]; text: string }>(view, `(() => { const r = fileLines("결과\\n[file] /a/b/notice-arch.png\\n[file] qa/findings.md\\n\`\`\`\\n[file] /in/fence\\n\`\`\`"); return { names: r.files.map(x => x.name), text: r.text }; })()`);
	expect(r.names).toEqual(["notice-arch.png", "findings.md"]);
	expect(r.text).toContain("[file] /in/fence");
	expect(await ev<string>(view, `ntPlain("끝났어요\\n[file] /a/b.png")`)).toBe("끝났어요");
});
