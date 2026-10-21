import { describe, expect, test } from "bun:test";
import { cleanName, friendlyName, MAX_NAME, peerInfoName, resolveName } from "./machine-name.ts";
import { peerName } from "./peers.ts";

describe("machine name", () => {
	test("empty or missing config falls back to the hostname-derived name", () => {
		expect(resolveName(undefined, "host.tail1234.ts.net.")).toBe("맥북");
		expect(resolveName("", "host")).toBe("맥미니");
		expect(resolveName("   ", "devbox.local")).toBe("devbox");
		expect(friendlyName("someone-mac-studio")).toBe("맥 스튜디오");
	});
	test("a chosen name wins and is cleaned", () => {
		expect(resolveName("  내 \n 맥북  ", "host")).toBe("내 맥북");
		expect(cleanName("a\u0000b")).toBe("a b");
		expect(cleanName(42)).toBe("");
		expect(cleanName("가".repeat(MAX_NAME + 10))).toHaveLength(MAX_NAME);
	});
	test("peer-info answers: the name, or undefined for an older or odd peer", () => {
		expect(peerInfoName({ name: " 서재 맥 " })).toBe("서재 맥");
		expect(peerInfoName({})).toBeUndefined();
		expect(peerInfoName({ name: 7 })).toBeUndefined();
		expect(peerInfoName(null)).toBeUndefined();
	});
	test("a peer shows its own chosen name, and an older peer without /api/peer-info falls back to undefined", async () => {
		expect(await peerName("https://a", async url => (url === "https://a/api/peer-info" ? { name: "작업실" } : null))).toBe("작업실");
		expect(await peerName("https://old", async () => { throw new Error("HTTP 404"); })).toBeUndefined();
	});
});
