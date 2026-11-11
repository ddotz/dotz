// Fetch for another gateway on the tailnet (owner 2026-10-29: "게이트웨이간에 왜 서로 연결이 안되는거지?"). A VPN on this computer (NordVPN
// on the MacBook) can take over the system DNS, and then a tailnet name (*.ts.net, MagicDNS) no longer resolves: every probe failed with
// ENOTFOUND and the MacBook listed only itself, while the Mac mini reached it fine. When a *.ts.net name does not resolve, its address is
// asked of Tailscale's own resolver (100.100.100.100) and the request goes to that address with the same TLS name and Host header.
import { Resolver } from "node:dns/promises";

const TS_DNS = "100.100.100.100";
const KEEP_MS = 5 * 60_000;
const ips = new Map<string, { ip: string; at: number }>();

const dnsFailure = (e: unknown): boolean => /ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? e}`);

async function tailnetIp(host: string): Promise<string | undefined> {
	const hit = ips.get(host);
	if (hit && Date.now() - hit.at < KEEP_MS) return hit.ip;
	const r = new Resolver({ timeout: 2000, tries: 1 });
	r.setServers([TS_DNS]);
	const [ip] = await r.resolve4(host).catch(() => [] as string[]);
	if (ip) ips.set(host, { ip, at: Date.now() });
	return ip;
}

export async function peerFetch(url: string | URL, init: RequestInit = {}, resolve: (host: string) => Promise<string | undefined> = tailnetIp): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		const u = new URL(url);
		const host = u.hostname.replace(/\.$/, "");
		if (!host.endsWith(".ts.net") || !dnsFailure(error)) throw error;
		const ip = await resolve(host);
		if (!ip) throw error;
		const via = new URL(u);
		via.hostname = ip;
		const headers = new Headers(init.headers);
		headers.set("host", u.host);
		return fetch(via, { ...init, headers, tls: { serverName: host } } as RequestInit);
	}
}
