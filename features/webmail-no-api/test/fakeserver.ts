// A fake webmail site for the tests: a tiny JSON mail API with cookie auth, ETag/conditional support, a search endpoint, a
// draft/send endpoint and a logout switch. It stands in for any real no-API webmail so the suite never needs a real site,
// a browser, the keychain or the network. Tests build a SiteSpec pointing at it and drive the adapter, keepalive and watch.
import type { SiteSpec } from "../lib/spec.ts";

export type FakeMail = { id: number; from: string; to?: string; subject: string; date: string; read: boolean; html: string };
// One file as the fake site received it: parts arrive under one upload id and are hashed as they come in.
export type FakeUpload = { name: string; bytes: number; parts: number; sha: string; big: boolean; contentLengths: (string | null)[]; maxPart: number };

export function startFakeServer(initial: FakeMail[] = [], opts: { xssi?: boolean } = {}) {
	let mails = [...initial];
	// The sent folder is mailbox 200, paged by ?page= (`ignorePage`: a site that answers the first page whatever the page).
	let sentMails: FakeMail[] = [];
	let sentPaging = { pageSize: 2, ignorePage: false, pageParam: "page" };
	const sentPages: number[] = [];
	let loggedOut = false;
	let failPart: number | undefined;
	let status = "done";
	const pending = new Map<string, { hasher: Bun.CryptoHasher; up: FakeUpload }>();
	const uploads: FakeUpload[] = [];
	const sent: any[] = [];
	const etag = () => `W/"${mails.length}-${Math.max(0, ...mails.map((m) => m.id))}"`;

	const authed = (req: Request): boolean => !loggedOut && (req.headers.get("cookie") ?? "").includes("session=good");
	const logoutResponse = () => new Response("<html><body><form id=login>password</form></body></html>", { status: 200, headers: { "content-type": "text/html" } });

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (!authed(req)) return logoutResponse();
			if (url.pathname === "/mail/mboxes/200/mails") {
				const page = sentPaging.ignorePage ? 1 : Number(url.searchParams.get(sentPaging.pageParam) ?? 1);
				sentPages.push(page);
				return Response.json({ mails: sentMails.slice((page - 1) * sentPaging.pageSize, page * sentPaging.pageSize).map(({ html, ...m }) => m) });
			}
			if (/\/mail\/mboxes\/\d+\/mails$/.test(url.pathname) && !url.searchParams.get("q")) {
				const tag = etag();
				if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { etag: tag } });
				const json = JSON.stringify({ mails: mails.map(({ html, ...m }) => m) });
				return new Response(opts.xssi ? `)]}',\n${json}` : json, { headers: { etag: tag, "content-type": "application/json" } });
			}
			if (url.pathname.endsWith("/search")) {
				const q = url.searchParams.get("q")?.toLowerCase() ?? "";
				const hits = mails.filter((m) => m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q));
				return Response.json({ mails: hits.map(({ html, ...m }) => m) });
			}
			const detail = url.pathname.match(/\/mail\/mails\/(\d+)$/);
			if (detail) {
				const m = [...mails, ...sentMails].find((x) => x.id === Number(detail[1]));
				return m ? Response.json({ id: m.id, html: m.html }) : new Response("not found", { status: 404 });
			}
			if (url.pathname === "/mail/read" && req.method === "POST") {
				const id = Number(new URLSearchParams(await req.text()).get("mailId"));
				const m = mails.find((x) => x.id === id);
				return m ? Response.json({ data: { content: m.html } }) : new Response("not found", { status: 404 });
			}
			if (url.pathname.startsWith("/mail/upload") && req.method === "POST") {
				const contentLength = req.headers.get("content-length");
				const form = await req.formData();
				const index = Number(form.get("index"));
				if (index === failPart) return new Response("part refused", { status: 500 });
				const part = form.get("file") as File;
				const uploadId = String(form.get("upload") || `u${pending.size + uploads.length + 1}`);
				const cur = pending.get(uploadId) ?? { hasher: new Bun.CryptoHasher("sha256"), up: { name: part.name, bytes: 0, parts: 0, sha: "", big: form.get("big") === "1", contentLengths: [], maxPart: 0 } };
				pending.set(uploadId, cur);
				const bytes = new Uint8Array(await part.arrayBuffer());
				cur.hasher.update(bytes);
				Object.assign(cur.up, { bytes: cur.up.bytes + bytes.length, parts: cur.up.parts + 1, maxPart: Math.max(cur.up.maxPart, bytes.length) });
				cur.up.contentLengths.push(contentLength);
				if (index < Number(form.get("count")) - 1) return Response.json({ uploadId });
				pending.delete(uploadId);
				cur.up.sha = cur.hasher.digest("hex");
				uploads.push(cur.up);
				const id = `f${uploads.length}`;
				return Response.json({ uploadId, file: { id, status, size: cur.up.bytes, ...(cur.up.big ? { link: `${url.origin}/dl/${id}` } : {}) } });
			}
			if (url.pathname.endsWith("/send") && req.method === "POST") {
				sent.push(await req.json());
				return Response.json({ ok: true });
			}
			return new Response("not found", { status: 404 });
		},
	});

	const origin = `http://localhost:${server.port}`;
	const spec: SiteSpec = {
		version: 1,
		site: "fake",
		origin,
		cookieHosts: ["localhost"],
		headers: { "X-Requested-With": "XMLHttpRequest" },
		list: { path: "/mail/mboxes/{mailbox}/mails", mailbox: "100", listPath: "mails", fields: { id: "id", from: "from", subject: "subject", time: "date", read: "read" } },
		read: { path: "/mail/mails/{id}", bodyPath: "html", bodyIsHtml: true },
		search: { path: "/mail/search", queryParam: "q" },
		send: {
			path: "/mail/send", method: "POST", draftOnly: true,
			upload: {
				path: "/mail/upload", form: { index: "{index}", count: "{count}", upload: "{upload}" }, chunkBytes: 1 << 20, uploadIdPath: "uploadId",
				idPath: "file.id", statusPath: "file.status", okStatus: "^done$",
				large: { minBytes: 4 << 20, path: "/mail/upload/big", form: { big: "1" }, linkPath: "file.link" },
			},
		},
	};

	return {
		server,
		origin,
		spec,
		cookieHeader: async () => "session=good",
		setLoggedOut: (v: boolean) => {
			loggedOut = v;
		},
		addMail: (m: FakeMail) => mails.unshift(m),
		uploads,
		sent,
		failPart: (i: number | undefined) => {
			failPart = i;
		},
		setUploadStatus: (s: string) => {
			status = s;
		},
		setSent: (m: FakeMail[], paging: Partial<typeof sentPaging> = {}) => {
			sentMails = [...m];
			sentPaging = { ...sentPaging, ...paging };
		},
		sentPages,
		setMails: (m: FakeMail[]) => {
			mails = [...m];
		},
		close: () => server.stop(true),
	};
}

// A mail the owner sent: it answers a question of the receiver, quoted below the reply.
export const mkSent = (id: number): FakeMail => ({ ...mkMail(id), to: `rcpt${id}@example.test`, subject: `Re: subject ${id}`, html: `<p>reply ${id} 가능해요.</p><p>&gt; question ${id}인가요?</p>` });

export const mkMail = (id: number, subject = `subject ${id}`): FakeMail => ({ id, from: `sender${id}@example.test`, subject, date: `2026-10-22T0${id % 10}:00:00Z`, read: false, html: `<p>body of ${id}</p>` });
