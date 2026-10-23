// A mail's attached files: the spec maps them out of the read response, the watcher fetches them from the site's own origin
// (by id or by url) and hands them to the gateway with the body. Everything runs against a tiny fake site.
import { expect, test } from "bun:test";
import { attachmentsOf, describeMail } from "../lib/adapter.ts";
import { type Ctx } from "../lib/config.ts";
import { validateSpec, type SiteSpec } from "../lib/spec.ts";
import { postToGateway } from "../lib/watchkit.ts";

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);
function site() {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (!(req.headers.get("cookie") ?? "").includes("session=good")) return new Response("login", { status: 200 });
			if (url.pathname === "/mail/mails/7") {
				return Response.json({ id: 7, html: "<p>견적서를 첨부합니다.</p>", files: [
					{ fid: "a1", name: "견적서.pdf", size: PDF.length, type: "application/pdf" },
					{ fid: "a2", name: "inline.txt", url: "/files/inline.txt" },
					{ fid: "a3", name: "elsewhere.txt", url: "https://other.example.test/x.txt" },
					{ fid: "a4", name: "missing.bin" },
				] });
			}
			if (url.pathname === "/mail/mails/7/att/a1") return new Response(PDF);
			if (url.pathname === "/files/inline.txt") return new Response("inline body");
			return new Response("not found", { status: 404 });
		},
	});
	const spec: SiteSpec = {
		version: 1, site: "fake", origin: `http://localhost:${server.port}`, cookieHosts: ["localhost"],
		list: { path: "/mail/mails", listPath: "mails", fields: { id: "id" } },
		read: { path: "/mail/mails/{id}", bodyPath: "html", bodyIsHtml: true, attachments: { listPath: "files", name: "name", id: "fid", url: "url", size: "size", type: "type" } },
		download: { path: "/mail/mails/{id}/att/{att}" },
	};
	const logs: string[] = [];
	const ctx: Ctx = { fetch: (...a) => fetch(...a), cookieHeader: async () => "session=good", now: () => 0, sleep: async () => {}, log: (m) => void logs.push(m) };
	return { server, spec, ctx, logs };
}

test("the spec's attachment map lists the files of a read response", () => {
	const { server, spec } = site();
	try {
		const raw = { files: [{ fid: "a1", name: "x.pdf", size: "12", type: "application/pdf" }, { name: "no-way-to-fetch" }, { fid: "b", name: "" }] };
		expect(attachmentsOf(spec, raw)).toEqual([{ name: "x.pdf", id: "a1", size: 12, type: "application/pdf" }]);
		expect(attachmentsOf({ ...spec, read: { ...spec.read, attachments: undefined } }, raw)).toEqual([]);
	} finally {
		server.stop(true);
	}
});

test("describeMail fetches the body and the files by id and by same-origin url, and skips the rest", async () => {
	const { server, spec, ctx, logs } = site();
	try {
		const d = await describeMail(ctx, spec, "7");
		expect(d.body).toBe("견적서를 첨부합니다.");
		expect(d.attachments!.map((a) => [a.name, a.type ?? null, Buffer.from(a.data, "base64").toString()])).toEqual([["견적서.pdf", "application/pdf", "%PDF-1"], ["inline.txt", null, "inline body"]]);
		expect(logs.some((l) => l.includes("elsewhere.txt"))).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("a spec without a file map posts only the body; the gateway post carries body and files", async () => {
	const { server, spec, ctx } = site();
	try {
		const plain = { ...spec, read: { ...spec.read, attachments: undefined } };
		expect(await describeMail(ctx, plain, "7")).toEqual({ body: "견적서를 첨부합니다.", html: "<p>견적서를 첨부합니다.</p>" });
		const calls: any[] = [];
		const res = { lines: ["mail 7 from=a: s"], mails: [{ id: "7", from: "a", subject: "s", time: "", read: false }] };
		const left = await postToGateway(async (m, p, b) => void calls.push([m, p, b]), "fake", res, () => {}, (m) => describeMail(ctx, spec, m.id));
		expect(left).toEqual([]);
		expect(calls[0][2].attachments.map((a: any) => a.name)).toEqual(["견적서.pdf", "inline.txt"]);
		expect(calls[0][2].body).toBe("견적서를 첨부합니다.");
		expect(calls[0][2].html).toBe("<p>견적서를 첨부합니다.</p>");
		const failing = await postToGateway(async (m, p, b) => void calls.push([m, p, b]), "fake", res, () => {}, async () => { throw new Error("HTTP 500"); });
		expect(failing).toEqual([]);
		expect(calls[1][2].attachments).toBeUndefined();
	} finally {
		server.stop(true);
	}
});

test("validateSpec wants a way to fetch each mapped file", () => {
	const { server, spec } = site();
	try {
		expect(validateSpec(spec)).toBeUndefined();
		expect(validateSpec({ ...spec, read: { ...spec.read, attachments: { listPath: "files" } } })).toContain("read.attachments");
		expect(validateSpec({ ...spec, download: undefined })).toContain("download.path");
		expect(validateSpec({ ...spec, download: undefined, read: { ...spec.read, attachments: { listPath: "files", name: "name", url: "url" } } })).toBeUndefined();
	} finally {
		server.stop(true);
	}
});
