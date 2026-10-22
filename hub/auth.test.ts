import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, paths } from "./config.ts";
import * as discord from "./discord.ts";
import { authRoute, pendingAuth, setFormLink } from "./auth.ts";
import { normalizeValue } from "./authfields.ts";
import { asksPersonalInChat } from "./personal-ask.ts";

const call = (path: string, method = "GET", body?: unknown) =>
	authRoute(new Request(`http://local${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`http://local${path}`))!;
const mode = (p: string) => statSync(p).mode & 0o777;

const FORM = [{ type: "name" }, { type: "phone" }, { type: "email" }, { type: "postal_code" }, { type: "address1" }, { type: "address2", optional: true }, { type: "card_holder" }, { type: "card_number" }, { type: "card_expiry" }, { type: "card_cvc" }, { type: "birth_date" }, { type: "id_number" }, { type: "other", label: "Gift code" }];
const VALUES: Record<string, string> = {
	name: "Kim Minsu",
	phone: "010-9876-5432",
	email: "minsu@example.com",
	postal_code: "06236",
	address1: "Zebra Unique Street 77",
	card_holder: "KIM MINSU",
	card_number: "4242 4242 4242 4242",
	card_expiry: "12/30",
	card_cvc: "7391",
	birth_date: "1990-04-05",
	id_number: "QX-55512-ZZ",
	other_gift_code: "GIFT-8472-PLUM",
};
const SECRET_BITS = ["4242424242424242", "4242 4242 4242 4242", "9876-5432", "Zebra Unique", "7391", "QX-55512", "GIFT-8472", "minsu@example.com"];

async function ask(body: Record<string, unknown>): Promise<string> {
	const r = await call("/api/auth", "POST", { site: "shop", kind: "form", purpose: "배송 정보", target: "chat", form: FORM, ...body });
	expect(r.status).toBe(200);
	return ((await r.json()) as { id: string }).id;
}

test("a form request renders typed inputs and masks card, CVC and ID fields", async () => {
	const id = await ask({ site: "shop-render" });
	const req = pendingAuth().find(a => a.id === id)!;
	expect(req.kind).toBe("form");
	const f = Object.fromEntries(req.fields.map(x => [x.name, x])) as Record<string, any>;
	expect(f.phone).toMatchObject({ type: "tel", inputmode: "tel", autocomplete: "tel" });
	expect(f.email).toMatchObject({ type: "email", autocomplete: "email" });
	expect(f.postal_code.autocomplete).toBe("postal-code");
	expect(f.address1.autocomplete).toBe("address-line1");
	expect(f.address2).toMatchObject({ autocomplete: "address-line2", optional: true });
	expect(f.card_number).toMatchObject({ inputmode: "numeric", autocomplete: "cc-number", mask: true });
	expect(f.card_expiry).toMatchObject({ inputmode: "numeric", autocomplete: "cc-exp", placeholder: "MM/YY" });
	expect(f.card_cvc).toMatchObject({ inputmode: "numeric", autocomplete: "cc-csc", mask: true });
	expect(f.id_number.mask).toBe(true);
	expect(f.other_gift_code.label).toBe("Gift code");
	expect(req.remember).toBe(false);
	await call(`/api/auth/${id}`, "DELETE");
});

test("light validation: Luhn card number, expiry format, phone, date", async () => {
	const id = await ask({ site: "shop-check" });
	const bad = async (key: string, value: string) => {
		const r = await call(`/api/auth/${id}`, "POST", { action: "submit", values: { ...VALUES, [key]: value } });
		expect(r.status).toBe(400);
		expect(await r.json()).toEqual({ error: "invalid", field: key });
	};
	await bad("card_number", "4242 4242 4242 4241");
	await bad("card_expiry", "13/30");
	await bad("phone", "abc");
	await bad("birth_date", "2090-01-01");
	await bad("email", "no-at-sign");
	const miss = await call(`/api/auth/${id}`, "POST", { action: "submit", values: { ...VALUES, name: "" } });
	expect(await miss.json()).toEqual({ error: "required", field: "name" });
	expect(((await (await call(`/api/auth/${id}`)).json()) as { status: string }).status).toBe("pending");
	expect(normalizeValue({ check: "expiry", maxlength: 7 }, "1230")).toBe("12/30");
	expect(normalizeValue({ check: "luhn", maxlength: 23 }, "4242-4242-4242-4242")).toBe("4242424242424242");
	await call(`/api/auth/${id}`, "DELETE");
});

test("one-time form: 0600 file under secrets/once, path and field names only, no value anywhere", async () => {
	const id = await ask({ site: "shop-once" });
	const r = await call(`/api/auth/${id}`, "POST", { action: "submit", values: VALUES });
	expect(r.status).toBe(200);
	const answered = await r.text();
	const view = await (await call(`/api/auth/${id}?wait=1`)).text();
	const parsed = JSON.parse(view) as { status: string; path: string; keys: string[]; once: boolean };
	expect(parsed.status).toBe("entered");
	expect(parsed.once).toBe(true);
	expect(parsed.path.startsWith(join(DATA_DIR, "secrets", "once"))).toBe(true);
	expect(parsed.keys).toEqual(["name", "phone", "email", "postal_code", "address1", "card_holder", "card_number", "card_expiry", "card_cvc", "birth_date", "id_number", "other_gift_code"]);
	expect(mode(parsed.path)).toBe(0o600);
	expect(mode(join(DATA_DIR, "secrets"))).toBe(0o700);
	const stored = JSON.parse(readFileSync(parsed.path, "utf8")) as Record<string, string>;
	expect(stored.card_number).toBe("4242424242424242");
	expect(stored.card_expiry).toBe("12/30");
	expect(stored.address2).toBeUndefined();
	const leaks = [answered, view, JSON.stringify(pendingAuth()), existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "", existsSync(paths.notices) ? readFileSync(paths.notices, "utf8") : "", existsSync(paths.outbox) ? readFileSync(paths.outbox, "utf8") : ""].join("\n");
	for (const bit of SECRET_BITS) expect(leaks).not.toContain(bit);
});

test("remember keeps the file as secrets/<site>; the owner's choice in the form wins", async () => {
	const id = await ask({ site: "shop-keep", remember: false, form: [{ type: "phone" }, { type: "card_number" }] });
	await call(`/api/auth/${id}`, "POST", { action: "submit", values: { phone: "010-1111-2222", card_number: "4242424242424242" }, remember: true });
	const parsed = (await (await call(`/api/auth/${id}`)).json()) as { path: string; once: boolean; keys: string[] };
	expect(parsed.path).toBe(join(DATA_DIR, "secrets", "shop-keep"));
	expect(parsed.once).toBe(false);
	expect(parsed.keys).toEqual(["phone", "card_number"]);
	expect(mode(parsed.path)).toBe(0o600);
});

test("bad form requests are refused", async () => {
	const post = (body: Record<string, unknown>) => call("/api/auth", "POST", { site: "shop-bad", kind: "form", purpose: "x", target: "chat", ...body });
	expect((await post({})).status).toBe(400);
	expect((await post({ form: [{ type: "ssn" }] })).status).toBe(400);
	expect((await post({ form: [{ type: "other" }] })).status).toBe(400);
	expect((await post({ form: [{ type: "phone" }, { type: "phone" }] })).status).toBe(400);
	expect((await post({ form: [{ type: "phone" }], remember: "yes" })).status).toBe(400);
	expect((await post({ site: "once", form: [{ type: "phone" }] })).status).toBe(400);
});

test("Discord carries a button that opens the web form and never a value input", async () => {
	const sent: { content: string; components: { components: { style: number; url?: string; custom_id?: string }[] }[] }[] = [];
	const post = spyOn(discord, "postRich").mockImplementation((async (_t: string, payload: any) => {
		sent.push(payload);
		return { channelId: "c1", messageId: "m1" };
	}) as never);
	const wasEnabled = discord.status.enabled;
	discord.status.enabled = true;
	setFormLink(() => "https://mac.example.ts.net");
	try {
		const id = await ask({ site: "shop-discord", form: [{ type: "address1" }, { type: "card_number" }] });
		const buttons = sent[0]!.components[0]!.components;
		expect(buttons[0]).toMatchObject({ style: 5, url: "https://mac.example.ts.net/" });
		expect(buttons[0]!.custom_id).toBeUndefined();
		expect(buttons).toHaveLength(2);
		expect(sent[0]!.content).toContain("배송 정보");
		await call(`/api/auth/${id}`, "DELETE");
	} finally {
		post.mockRestore();
		discord.status.enabled = wasEnabled;
		setFormLink(() => undefined);
	}
});

test("a chat message that asks for card, address or phone is flagged; the form pointer and plain talk are not", () => {
	expect(asksPersonalInChat("배송받을 집 주소랑 전화번호 알려주세요")).toBe(true);
	expect(asksPersonalInChat("결제하려면 카드 번호를 보내 주세요")).toBe(true);
	expect(asksPersonalInChat("Please send me your card number and CVC")).toBe(true);
	expect(asksPersonalInChat("What is your home address?")).toBe(true);
	expect(asksPersonalInChat("카드 번호는 앱의 입력 창에서 입력해 주세요")).toBe(false);
	expect(asksPersonalInChat("I opened the secure form for your card number")).toBe(false);
	expect(asksPersonalInChat("빌드가 끝났어요. 주소 변경은 필요 없어요")).toBe(false);
	expect(asksPersonalInChat("서버 비밀번호 파일을 지웠어요")).toBe(false);
});
