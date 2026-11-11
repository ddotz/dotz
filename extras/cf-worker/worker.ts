// web.access = "cloudflare" without a domain: https://<name>.<account>.workers.dev runs this Worker, which hands every request unchanged
// (method, path, query, headers incl. cookies and Cf-Access-Jwt-Assertion, body) to the Mac's gateway through a Workers VPC Service
// binding on the same Cloudflare Tunnel, and streams the answer back (SSE included). It adds, removes and checks nothing: the gateway's
// device gate (hub/devices.ts) or x-dotz-token decides, exactly as for a tunnel Public Hostname. Setup: docs/web-access-cloudflare.ko.md.
export type Env = { DOTZ: { fetch(request: Request): Promise<Response> } };

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		// The VPC Service decides where the request goes; the URL's host only fills the Host header, which the gateway's same-origin
		// checks compare with Origin, so it stays the workers.dev host. "http:" because the service points at http://127.0.0.1:<web.port>.
		const url = new URL(request.url);
		url.protocol = "http:";
		return env.DOTZ.fetch(new Request(url, request));
	},
};
