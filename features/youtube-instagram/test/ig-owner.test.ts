// "Did the owner already answer?" for Instagram comments: an own-comment id under the media list, or an @mention of the commenter.
// Pure view tests plus the ig-comments watch that uses them. Fixtures only, no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { run } from "../bin/ig-comments.ts";
import { mentions, ownerView, UNKNOWN_USER } from "../lib/ig-owner.ts";
import type { IgComment } from "../lib/instagram.ts";
import { fakeCtx, IG, setupEnv, type TestEnv } from "./helpers.ts";

const OWNER = { userId: "17841", username: "owner_ig" };
const top = (id: string, username: string, timestamp: string, text = "hi", o: Partial<IgComment> = {}): IgComment => ({ id, text, username, timestamp, replies: [], ...o });

test("a reply whose id is one of the owner's own comments (from.id) counts as answered", () => {
	const list = [
		top("k1", "fan1", "2030-06-15T12:10:00Z", "q", { replies: [{ id: "r1", username: UNKNOWN_USER, text: "thanks" }] }),
		top("r1", "17841", "2030-06-15T12:15:00Z", "thanks", { fromId: "17841" }),
		top("k2", "fan2", "2030-06-15T12:20:00Z", "q2", { replies: [{ id: "r9", username: UNKNOWN_USER, text: "me too" }] }),
	];
	const view = ownerView(list, OWNER);
	expect(view.answered(list[0]!)).toBe(true);
	expect(view.answered(list[2]!)).toBe(false);
	expect(view.isOwner(list[1]!)).toBe(true);
	expect(view.isOwner({ id: "x", username: "someone", fromId: "17841" })).toBe(true);
});

test("the owner @mentioning the commenter under the same media counts as answered, but only from the comment on", () => {
	const fan = top("k1", "bob", "2030-06-15T12:10:00Z");
	const answeredLater = [fan, top("k2", "owner_ig", "2030-06-15T12:30:00Z", "@bob 고마워요!")];
	expect(ownerView(answeredLater, OWNER).answered(fan)).toBe(true);
	const mentionedBefore = [fan, top("k2", "owner_ig", "2030-06-15T11:00:00Z", "@bob 고마워요!")];
	expect(ownerView(mentionedBefore, OWNER).answered(fan)).toBe(false);
	const otherName = [fan, top("k2", "owner_ig", "2030-06-15T12:30:00Z", "@bobby 고마워요!")];
	expect(ownerView(otherName, OWNER).answered(fan)).toBe(false);
	const viaReply = [fan, top("k3", "fan9", "2030-06-15T12:05:00Z", "x", { replies: [{ id: "r2", username: "owner_ig", text: "@bob 맞아요", timestamp: "2030-06-15T12:40:00Z" }] })];
	expect(ownerView(viaReply, OWNER).answered(fan)).toBe(true);
});

test("mentions matches the whole name, case-insensitively, and never an unknown user", () => {
	expect(mentions("고마워요 @Bob!", "bob")).toBe(true);
	expect(mentions("@bob.smith 안녕", "bob")).toBe(false);
	expect(mentions("mail@bob", "bob")).toBe(false);
	expect(mentions(`@${UNKNOWN_USER}`, UNKNOWN_USER)).toBe(false);
});

let env: TestEnv;
beforeEach(() => {
	env = setupEnv();
});
afterEach(() => env.cleanup());

test("the watch prints only comments the owner has not answered (by id or by mention)", async () => {
	const MEDIA = `GET ${IG}/me/media`;
	const COMMENTS = `GET ${IG}/m1/comments`;
	const media = (count: number) => ({ data: [{ id: "m1", comments_count: count, timestamp: "2030-06-01T00:00:00+0000" }] });
	const ctx = fakeCtx(env, { routes: { [MEDIA]: () => media(1) } });
	await run(ctx, []);
	ctx.routes[MEDIA] = () => media(6);
	ctx.routes[COMMENTS] = () => ({
		data: [
			{ id: "k1", text: "by id", username: "fan1", timestamp: "2030-06-15T12:10:00+0000", replies: { data: [{ id: "r1", text: "thanks" }] } },
			{ id: "r1", text: "thanks", from: { id: "17841" }, timestamp: "2030-06-15T12:15:00+0000" },
			{ id: "k2", text: "by mention", username: "bob", timestamp: "2030-06-15T12:20:00+0000" },
			{ id: "k4", text: "@bob 고마워요", username: "owner_ig", timestamp: "2030-06-15T12:30:00+0000" },
			{ id: "k3", text: "open", username: "fan3", timestamp: "2030-06-15T12:40:00+0000", replies: { data: [{ id: "r7", text: "same here" }] } },
		],
	});
	expect(await run(ctx, [])).toEqual({ lines: ["ig-comment k3 media=m1 by=fan3: open"], code: 0 });
});
