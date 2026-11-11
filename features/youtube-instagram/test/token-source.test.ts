import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../bin/tokens.ts";
import { type Config, type InstagramSecret, paths, readJson, type TokenSource, writeJson } from "../lib/config.ts";
import { publishState, setPublishMissing } from "../lib/ig-publish.ts";
import { fakeCtx, IG, NOW, setupEnv, type TestEnv, TOKEN_URL } from "./helpers.ts";

const ME = `GET ${IG}/me`;
const REFRESH = "GET https://graph.instagram.com/refresh_access_token";
const TOKEN = `POST ${TOKEN_URL}`;
let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

const source = () => join(env.dir, "ig-source.json");
const fails = (platform = "instagram") => JSON.parse(readFileSync(join(env.stateDir, `token-source-${platform}.json`), "utf8")).fails as number;
const stored = () => JSON.parse(readFileSync(paths.instagram(), "utf8")) as InstagramSecret;
const mode = (file: string) => statSync(file).mode & 0o777;

function wire(app: "instagram" | "youtube", src: TokenSource): void {
	const cfg = readJson<Config>(paths.config())!;
	cfg[app]!.token_source = src;
	writeJson(paths.config(), cfg);
}
const dueCopy = () => writeJson(paths.instagram(), { access_token: "ig-token", user_id: "17841", username: "owner_ig", obtained_at: "2030-06-01T00:00:00.000Z", expires_at: "2030-07-31T00:00:00.000Z" }, true);
const meOk = () => ({ user_id: "17841", username: "owner_ig" });
const newer = { access_token: "ig-new", obtained_at: "2030-06-14T00:00:00.000Z", expires_at: "2030-08-13T00:00:00.000Z" };

test("a copy that is not due is left alone: the source is not even read", async () => {
	wire("instagram", { file: source() });
	const ctx = fakeCtx(env);
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls).toHaveLength(0);
	expect(() => fails()).toThrow();
});

test("a due copy takes a newer token from the file after /me accepted it, 0600, without dotz refreshing it", async () => {
	dueCopy();
	writeFileSync(source(), JSON.stringify(newer));
	wire("instagram", { file: source() });
	const ctx = fakeCtx(env, { routes: { [ME]: () => meOk() } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(ctx.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v23.0/me"]);
	expect(ctx.calls[0].headers.authorization).toBe("Bearer ig-new");
	expect(stored()).toMatchObject({ access_token: "ig-new", user_id: "17841", username: "owner_ig", obtained_at: newer.obtained_at, expires_at: newer.expires_at });
	expect(mode(paths.instagram())).toBe(0o600);
});

test("a bare token file and a command source work the same way, and a new token clears the missing publish permission", async () => {
	dueCopy();
	setPublishMissing(fakeCtx(env));
	writeFileSync(source(), "IGbare\n");
	wire("instagram", { file: source() });
	await run(fakeCtx(env, { routes: { [ME]: () => meOk() } }), []);
	expect(stored()).toMatchObject({ access_token: "IGbare", obtained_at: NOW });
	expect(publishState().missing).toBe(false);

	dueCopy();
	wire("instagram", { command: ["/bin/print-token", "--json"] });
	const ctx = fakeCtx(env, { routes: { [ME]: () => meOk() }, exec: async () => ({ code: 0, stdout: JSON.stringify(newer), stderr: "" }) });
	await run(ctx, []);
	expect(ctx.execs).toEqual([["/bin/print-token", "--json"]]);
	expect(stored().access_token).toBe("ig-new");
});

test("failures are counted: silent the first time, DOTZ_FAIL token-source from the 2nd in a row, reset by a success", async () => {
	dueCopy();
	wire("instagram", { file: source() });
	const ctx = fakeCtx(env, { routes: { [ME]: () => meOk() } });
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(fails()).toBe(1);
	const second = await run(ctx, []);
	expect(second.code).toBe(1);
	expect(second.lines[0]).toBe("DOTZ_FAIL token-source");
	expect(fails()).toBe(2);

	writeFileSync(source(), JSON.stringify(newer));
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(fails()).toBe(0);

	dueCopy();
	writeFileSync(source(), "not json {");
	expect(await run(ctx, [])).toEqual({ lines: [], code: 0 });
	expect(fails()).toBe(1);
});

test("a source that stays behind (same token or older) is a failure, and dotz does not refresh the copy itself", async () => {
	dueCopy();
	writeFileSync(source(), JSON.stringify({ access_token: "ig-token" }));
	wire("instagram", { file: source() });
	const ctx = fakeCtx(env, { routes: { [REFRESH]: () => ({ access_token: "x", expires_in: 1 }) } });
	await run(ctx, []);
	const second = await run(ctx, []);
	expect(second.lines[0]).toBe("DOTZ_FAIL token-source");
	expect(second.lines.join("\n")).not.toContain("ig-token");
	expect(ctx.calls).toHaveLength(0);
	expect(stored().access_token).toBe("ig-token");
});

test("a token of another account, or one Instagram rejects, is never stored and counts as a source failure", async () => {
	dueCopy();
	writeFileSync(source(), JSON.stringify(newer));
	wire("instagram", { file: source() });
	const other = fakeCtx(env, { routes: { [ME]: () => ({ user_id: "999", username: "someone" }) } });
	await run(other, []);
	expect((await run(other, [])).lines[0]).toBe("DOTZ_FAIL token-source");
	const rejected = fakeCtx(env, { routes: { [ME]: () => new Response("{}", { status: 401 }) } });
	expect((await run(rejected, [])).lines[0]).toBe("DOTZ_FAIL token-source");
	expect(stored().access_token).toBe("ig-token");
});

test("a failing command is a source failure that never leaks its output", async () => {
	dueCopy();
	wire("instagram", { command: ["/bin/print-token"] });
	const ctx = fakeCtx(env, { exec: async () => ({ code: 3, stdout: "SECRET-OUT", stderr: "SECRET-ERR" }) });
	await run(ctx, []);
	const second = await run(ctx, []);
	expect(second.lines[0]).toBe("DOTZ_FAIL token-source");
	expect(second.lines.join("\n")).not.toContain("SECRET");
});

test("a YouTube source swaps the refresh token only after Google accepted it, keeps the client, and rolls back otherwise", async () => {
	writeFileSync(source(), JSON.stringify({ refresh_token: "new-rt" }));
	wire("youtube", { file: source() });
	const ok = fakeCtx(env, { routes: { [TOKEN]: () => ({ access_token: "yt-new", expires_in: 3600 }) } });
	expect(await run(ok, [])).toEqual({ lines: [], code: 0 });
	expect(new URLSearchParams(ok.calls[0].body).get("refresh_token")).toBe("new-rt");
	expect(JSON.parse(readFileSync(paths.ytOauth(), "utf8"))).toEqual({ client_id: "cid", client_secret: "csecret", refresh_token: "new-rt" });
	expect(JSON.parse(readFileSync(paths.ytAccess(), "utf8")).access_token).toBe("yt-new");

	writeFileSync(source(), JSON.stringify({ refresh_token: "bad-rt" }));
	const bad = fakeCtx(env, { routes: { [TOKEN]: () => Response.json({ error: "invalid_grant" }, { status: 400 }) } });
	await run(bad, []);
	expect((await run(bad, [])).lines[0]).toBe("DOTZ_FAIL token-source");
	expect(JSON.parse(readFileSync(paths.ytOauth(), "utf8")).refresh_token).toBe("new-rt");
	expect(JSON.parse(readFileSync(paths.ytAccess(), "utf8")).access_token).toBe("yt-new");
	expect(fails("youtube")).toBe(2);
});
