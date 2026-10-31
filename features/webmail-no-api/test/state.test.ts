// The site's own read / replied flags reach the gateway each poll (lib/adapter.ts mapMails, lib/watchkit.ts postStates).
import { expect, test } from "bun:test";
import { mapMails } from "../lib/adapter.ts";
import { postStates } from "../lib/watchkit.ts";
import { type SiteSpec } from "../lib/spec.ts";

const spec = (fields: SiteSpec["list"]["fields"]) => ({ list: { path: "/l", listPath: "items", fields } }) as unknown as SiteSpec;

test("a read field, an unread field read the other way round, and an answered field", () => {
	const body = { items: [{ id: "1", seen: "Y", unread: 0, ans: "1" }, { id: "2", seen: "N", unread: 1, ans: "0" }] };
	expect(mapMails(spec({ id: "id", read: "seen", answered: "ans" }), body).map((m) => [m.id, m.read, m.replied])).toEqual([["1", true, true], ["2", false, false]]);
	expect(mapMails(spec({ id: "id", read: "unread" }), body).map((m) => [m.id, m.read, m.replied])).toEqual([["1", true, undefined], ["2", false, undefined]]);
});

test("one POST /api/mail/state per poll with only the clearly-true states; nothing when none", async () => {
	const calls: [string, string, unknown][] = [];
	const gw = async (m: string, p: string, b?: unknown) => void calls.push([m, p, b]);
	const m = (id: string, read: boolean, replied?: boolean) => ({ id, from: "", subject: "", time: "", read, ...(replied === undefined ? {} : { replied }) });
	await postStates(gw, "site", { listed: [m("1", true), m("2", false), m("3", false, true)] }, () => {});
	await postStates(gw, "site", { listed: [m("4", false)] }, () => {});
	expect(calls).toEqual([["POST", "/api/mail/state", { source: "site", items: [{ id: "1", read: true }, { id: "3", replied: true }] }]]);
});
