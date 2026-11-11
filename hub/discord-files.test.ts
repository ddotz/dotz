// Result files on Discord: a `[file] /abs/path` line in an outgoing message becomes an attachment posted by the bot (fake
// Discord REST server, DOTZ_DISCORD_API); too big or rejected as too large (413) -> the gateway download link; a path the
// file route would not serve -> a short note, never the file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as discord from "./discord.ts";
import { FileError } from "./files.ts";

type Req = { path: string; type: string; payload: any; files: { name: string; bytes: string }[] };
const requests: Req[] = [];
let tooLarge = false;
let server: ReturnType<typeof Bun.serve>;
const DIR = join(process.env.DOTZ_DIR!, "discord-files");
mkdirSync(DIR, { recursive: true });
const small = join(DIR, "chart.png");
const big = join(DIR, "deck.pptx");
writeFileSync(small, "PNGDATA");
writeFileSync(big, "x".repeat(500));

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const type = req.headers.get("content-type") ?? "";
			if (type.startsWith("multipart/form-data")) {
				const form = await req.formData();
				const files: Req["files"] = [];
				for (const [k, v] of form.entries()) if (k.startsWith("files[") && typeof v !== "string") files.push({ name: v.name, bytes: await v.text() });
				requests.push({ path: url.pathname, type: "multipart", payload: JSON.parse(String(form.get("payload_json"))), files });
				if (tooLarge) return Response.json({ message: "Request entity too large", code: 40005 }, { status: 413 });
			} else {
				const text = await req.text();
				requests.push({ path: url.pathname, type: "json", payload: text ? JSON.parse(text) : undefined, files: [] });
			}
			return Response.json({ id: `m${requests.length}` });
		},
	});
	process.env.DOTZ_DISCORD_API = `http://127.0.0.1:${server.port}/api/v10`;
	discord.status.enabled = true;
	discord.channels.work["222"] = "files";
	discord.attach.maxBytes = 100;
	discord.setFileResolver(p => {
		if (!p.startsWith(DIR)) throw new FileError("열 수 없는 위치예요", 403);
		return p;
	});
	discord.setFileLink(p => `https://gw.example:8443/api/file?path=${encodeURIComponent(p)}&dl=1`);
});
afterAll(() => {
	server.stop(true);
	delete process.env.DOTZ_DISCORD_API;
});

test("fileLines takes [file] lines out of the text, but not inside a ``` block", () => {
	const r = discord.fileLines(`[done] 결과\n[file] ${small}\n\`\`\`\n[file] /in/fence\n\`\`\``);
	expect(r.files).toEqual([small]);
	expect(r.text).toBe("[done] 결과\n```\n[file] /in/fence\n```");
});

test("a small file is attached to the message by the bot; the [file] line is not shown", async () => {
	requests.length = 0;
	const r = await discord.send("ch:222", `결과 보고\n[file] ${small}`);
	expect(r.delivered).toBe(true);
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ path: "/api/v10/channels/222/messages", type: "multipart" });
	expect(requests[0]!.payload.content).toBe("결과 보고");
	expect(requests[0]!.payload.attachments).toEqual([{ id: 0, filename: "chart.png" }]);
	expect(requests[0]!.files).toEqual([{ name: "chart.png", bytes: "PNGDATA" }]);
});

test("a file over the upload limit goes out as the gateway download link", async () => {
	requests.length = 0;
	await discord.send("ch:222", `덱 완성\n[file] ${big}`);
	expect(requests).toHaveLength(1);
	expect(requests[0]!.type).toBe("json");
	expect(requests[0]!.payload.content).toContain("덱 완성");
	expect(requests[0]!.payload.content).toContain(`https://gw.example:8443/api/file?path=${encodeURIComponent(big)}&dl=1`);
	expect(requests[0]!.payload.content).toContain("deck.pptx");
});

test("a path the file route would not serve is never sent; the message says why", async () => {
	requests.length = 0;
	await discord.send("ch:222", "보고\n[file] /etc/hosts");
	expect(requests).toHaveLength(1);
	expect(requests[0]!.type).toBe("json");
	expect(requests[0]!.payload.content).toContain("hosts");
	expect(requests[0]!.payload.content).toContain("열 수 없는 위치예요");
	expect(requests[0]!.payload.content).not.toContain("api/file");
});

test("Discord rejecting the upload as too large (413) re-posts the message with download links", async () => {
	requests.length = 0;
	tooLarge = true;
	try {
		const r = await discord.send("ch:222", `이미지\n[file] ${small}`);
		expect(r.delivered).toBe(true);
	} finally {
		tooLarge = false;
	}
	expect(requests.map(r => r.type)).toEqual(["multipart", "json"]);
	expect(requests[1]!.payload.content).toContain("이미지");
	expect(requests[1]!.payload.content).toContain(`path=${encodeURIComponent(small)}`);
});
