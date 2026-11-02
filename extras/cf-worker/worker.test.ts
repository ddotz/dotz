import { describe, expect, test } from "bun:test";
import worker from "./worker.ts";

const HOST = "dotz.owner.workers.dev";

// A VPC Service binding stand-in: records what reaches the gateway and answers with `reply`.
const binding = (reply: (req: Request) => Response) => {
	const seen: Request[] = [];
	return { seen, env: { DOTZ: { fetch: async (req: Request) => (seen.push(req), reply(req)) } } };
};

describe("workers.dev forwarder", () => {
	test("method, path, query, headers and body reach the gateway unchanged, on the workers.dev host", async () => {
		const b = binding(() => new Response("ok"));
		const headers = { cookie: "dotz_dev=abc", "cf-access-jwt-assertion": "jwt", "x-dotz-token": "t", origin: `https://${HOST}`, "content-type": "application/json" };
		const res = await worker.fetch(new Request(`https://${HOST}/api/send?to=main&x=1`, { method: "POST", headers, body: '{"text":"hi"}' }), b.env);
		expect(await res.text()).toBe("ok");
		const got = b.seen[0]!;
		expect([got.method, got.url]).toEqual(["POST", `http://${HOST}/api/send?to=main&x=1`]);
		for (const [k, v] of Object.entries(headers)) expect(got.headers.get(k)).toBe(v);
		expect(await got.text()).toBe('{"text":"hi"}');
	});

	test("the answer streams back as it comes: an SSE frame arrives before the stream ends", async () => {
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start: c => void (push = c) });
		const b = binding(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		const res = await worker.fetch(new Request(`https://${HOST}/api/events`), b.env);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = res.body!.getReader();
		push.enqueue(new TextEncoder().encode("data: 1\n\n"));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
		push.close();
		expect((await reader.read()).done).toBe(true);
	});

	test("status and headers come back as the gateway sent them: an unpaired page load keeps its redirect to /pair", async () => {
		const b = binding(() => new Response(null, { status: 302, headers: { Location: "/pair", "set-cookie": "a=1" } }));
		const res = await worker.fetch(new Request(`https://${HOST}/`), b.env);
		expect([res.status, res.headers.get("location"), res.headers.get("set-cookie")]).toEqual([302, "/pair", "a=1"]);
	});
});
