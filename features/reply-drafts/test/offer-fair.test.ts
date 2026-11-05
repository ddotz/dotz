import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ModelCall } from "../../../hub/reply-draft.ts";
import { offerMailDraft, requestMailDraft, type OfferMail } from "../lib/offer.ts";
import { paths } from "../lib/settings.ts";
import { enable, j, mailFixture, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(() => env.cleanup());
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), join(env.dir, "draft-files")]) rmSync(p, { force: true, recursive: true });
	enable(env);
});

const skipReply = j({ action: "skip", reason: "newsletter", to: "", body: "", questions: [] });
const mail = (key: string, account: string): OfferMail => ({ ...mailFixture, key, id: key, account, body: `body of ${key}` });

// A model that parks every call until the test releases it, and records which mail each call was for, in call order.
function gatedModel() {
	const arrivals: string[] = [];
	const parked: (() => void)[] = [];
	let wake: (() => void) | undefined;
	const call: ModelCall = async (_system, user) => {
		arrivals.push(/body of (\S+)/.exec(user)![1]!);
		await new Promise<void>(release => {
			parked.push(release);
			wake?.();
		});
		return skipReply;
	};
	const releaseOne = async () => {
		while (!parked.length) await new Promise<void>(r => void (wake = r));
		parked.shift()!();
	};
	const drain = async (all: Promise<unknown[]>) => {
		let finished = false;
		const end = all.then(() => void (finished = true));
		while (!finished) await Promise.race([model.releaseOne(), end]);
		return all;
	};
	const model = { arrivals, call, releaseOne, drain };
	return model;
}

describe("the mail draft queue is fair across mail apps", () => {
	test("a mail of app B is drafted after at most a few of app A's backlog", async () => {
		const model = gatedModel();
		const mails = [...Array.from({ length: 30 }, (_, i) => mail(`a-${i}`, "a@example.com")), mail("b-0", "b@example.com")];
		const done = mails.map(m => offerMailDraft(m, { send: () => {}, call: model.call, log: () => {} }));
		expect(await model.drain(Promise.all(done))).toEqual(mails.map(() => "skipped"));
		expect(model.arrivals).toHaveLength(31);
		expect(model.arrivals.indexOf("b-0")).toBeLessThanOrEqual(2);
	});

	test("an owner's 초안 작성 request goes before the whole automatic backlog", async () => {
		const model = gatedModel();
		const backlog = Array.from({ length: 30 }, (_, i) => mail(`a-${i}`, "a@example.com"));
		const done = backlog.map(m => offerMailDraft(m, { send: () => {}, call: model.call, log: () => {} }));
		done.push(requestMailDraft(mail("own-0", "a@example.com"), { send: () => {}, call: model.call, log: () => {} }));
		await model.drain(Promise.all(done));
		expect(model.arrivals.indexOf("own-0")).toBeLessThanOrEqual(2);
	});

	test("with 200 mails queued the mail reads in flight stay bounded", async () => {
		let active = 0, peak = 0, reads = 0;
		const counted = async <T>(value: T): Promise<T> => {
			reads++;
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			await Promise.resolve();
			active--;
			return value;
		};
		const deps = {
			send: () => {},
			call: (async () => skipReply) as ModelCall,
			log: () => {},
			readBody: (_source: string, id: string) => counted<string | undefined>(`body of ${id}`),
			history: () => counted<string[]>([]),
		};
		const results = await Promise.all(Array.from({ length: 200 }, (_, i) => offerMailDraft(mail(`c-${i}`, `acct${i % 4}@example.com`), deps)));
		expect(results.every(r => r === "skipped")).toBe(true);
		expect(reads).toBe(400);
		expect(peak).toBeLessThanOrEqual(8);
	});
});
