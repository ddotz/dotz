// A fake webmail site for the tests: a tiny JSON mail API with cookie auth, ETag/conditional support, a search endpoint, a
// draft/send endpoint and a logout switch. It stands in for any real no-API webmail so the suite never needs a real site,
// a browser, the keychain or the network. Tests build a SiteSpec pointing at it and drive the adapter, keepalive and watch.
import type { SiteSpec } from "../lib/spec.ts";

export type FakeMail = { id: number; from: string; subject: string; date: string; read: boolean; html: string };

export function startFakeServer(initial: FakeMail[] = [], opts: { xssi?: boolean } = {}) {
	let mails = [...initial];
	let loggedOut = false;
	const etag = () => `W/"${mails.length}-${Math.max(0, ...mails.map((m) => m.id))}"`;

	const authed = (req: Request): boolean => !loggedOut && (req.headers.get("cookie") ?? "").includes("session=good");
	const logoutResponse = () => new Response("<html><body><form id=login>password</form></body></html>", { status: 200, headers: { "content-type": "text/html" } });

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (!authed(req)) return logoutResponse();
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
				const m = mails.find((x) => x.id === Number(detail[1]));
				return m ? Response.json({ id: m.id, html: m.html }) : new Response("not found", { status: 404 });
			}
			if (url.pathname === "/mail/read" && req.method === "POST") {
				const id = Number(new URLSearchParams(await req.text()).get("mailId"));
				const m = mails.find((x) => x.id === id);
				return m ? Response.json({ data: { content: m.html } }) : new Response("not found", { status: 404 });
			}
			if (url.pathname.endsWith("/send") && req.method === "POST") return Response.json({ ok: true });
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
		send: { path: "/mail/send", method: "POST", draftOnly: true },
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
		setMails: (m: FakeMail[]) => {
			mails = [...m];
		},
		close: () => server.stop(true),
	};
}

export const mkMail = (id: number, subject = `subject ${id}`): FakeMail => ({ id, from: `sender${id}@example.test`, subject, date: `2026-10-22T0${id % 10}:00:00Z`, read: false, html: `<p>body of ${id}</p>` });
