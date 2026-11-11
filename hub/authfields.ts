// Typed fields of the personal-data form (dotz_auth kind=form, hub/auth.ts): what each field renders as in the web form
// (input type, mobile keyboard, autocomplete token, masking) and how its value is checked and normalized before it is stored.
// Pure and free of gateway side effects, so tests and the tool schema (extension/index.ts) share it.

export const FIELD_TYPES = ["name", "phone", "email", "postal_code", "address1", "address2", "card_holder", "card_number", "card_expiry", "card_cvc", "birth_date", "id_number", "account_number", "other"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FormFieldSpec = { type: FieldType; label?: string; optional?: boolean; mask?: boolean };
type Check = "text" | "phone" | "email" | "postal" | "luhn" | "expiry" | "cvc" | "date" | "id" | "account";
type Def = { input: "text" | "tel" | "email"; inputmode: string; autocomplete: string; mask: boolean; check: Check; max: number; optional?: boolean };

const DEFS: Record<FieldType, Def> = {
	name: { input: "text", inputmode: "text", autocomplete: "name", mask: false, check: "text", max: 80 },
	phone: { input: "tel", inputmode: "tel", autocomplete: "tel", mask: false, check: "phone", max: 24 },
	email: { input: "email", inputmode: "email", autocomplete: "email", mask: false, check: "email", max: 120 },
	postal_code: { input: "text", inputmode: "text", autocomplete: "postal-code", mask: false, check: "postal", max: 10 },
	address1: { input: "text", inputmode: "text", autocomplete: "address-line1", mask: false, check: "text", max: 200 },
	address2: { input: "text", inputmode: "text", autocomplete: "address-line2", mask: false, check: "text", max: 200, optional: true },
	card_holder: { input: "text", inputmode: "text", autocomplete: "cc-name", mask: false, check: "text", max: 80 },
	card_number: { input: "text", inputmode: "numeric", autocomplete: "cc-number", mask: true, check: "luhn", max: 23 },
	card_expiry: { input: "text", inputmode: "numeric", autocomplete: "cc-exp", mask: false, check: "expiry", max: 7 },
	card_cvc: { input: "text", inputmode: "numeric", autocomplete: "cc-csc", mask: true, check: "cvc", max: 4 },
	birth_date: { input: "text", inputmode: "numeric", autocomplete: "bday", mask: false, check: "date", max: 10 },
	id_number: { input: "text", inputmode: "text", autocomplete: "off", mask: true, check: "id", max: 30 },
	account_number: { input: "text", inputmode: "text", autocomplete: "off", mask: true, check: "account", max: 34 },
	other: { input: "text", inputmode: "text", autocomplete: "off", mask: false, check: "text", max: 500 },
};

export type FormField = { key: string; type: FieldType; label: string; input: Def["input"]; inputmode: string; autocomplete: string; mask: boolean; optional: boolean; maxlength: number; placeholder: string; check: Check };

const LABEL_MAX = 40;
const FIELDS_MAX = 16;
const PLACEHOLDERS: Partial<Record<FieldType, string>> = { card_expiry: "MM/YY", birth_date: "YYYY-MM-DD", card_number: "1234 5678 9012 3456", phone: "010-1234-5678" };

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "x";

// Parses the request's `form` list. A string is the error (sent back to the bot); labels fall back to `labelOf`.
export function buildForm(raw: unknown, labelOf: (t: FieldType) => string): FormField[] | string {
	if (!Array.isArray(raw) || !raw.length) return "form must be a non-empty list of {type, label?, optional?, mask?}";
	if (raw.length > FIELDS_MAX) return `form has at most ${FIELDS_MAX} fields`;
	const out: FormField[] = [];
	const keys = new Set<string>();
	for (const item of raw) {
		const it = item as Partial<FormFieldSpec> | null;
		if (!it || typeof it !== "object" || !FIELD_TYPES.includes(it.type as FieldType)) return `form field type must be one of ${FIELD_TYPES.join(", ")}`;
		const type = it.type as FieldType;
		const label = typeof it.label === "string" ? it.label.trim().slice(0, LABEL_MAX) : "";
		if (type === "other" && !label) return "an 'other' form field needs a label";
		let key = type === "other" ? `other_${slug(label)}` : type;
		for (let n = 2; type === "other" && keys.has(key); n++) key = `other_${slug(label)}_${n}`;
		if (keys.has(key)) return `form field ${type} is listed twice`;
		keys.add(key);
		const d = DEFS[type];
		out.push({ key, type, label: label || labelOf(type), input: d.input, inputmode: d.inputmode, autocomplete: d.autocomplete, mask: it.mask === true || d.mask, optional: it.optional === true || d.optional === true, maxlength: d.max, placeholder: PLACEHOLDERS[type] ?? "", check: d.check });
	}
	return out;
}

const digits = (s: string) => s.replace(/\D/g, "");

function luhn(num: string): boolean {
	let sum = 0;
	for (let i = 0; i < num.length; i++) {
		let d = Number(num[num.length - 1 - i]);
		if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
		sum += d;
	}
	return sum % 10 === 0;
}

function realDate(y: number, m: number, d: number): boolean {
	const t = new Date(Date.UTC(y, m - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// The value to store, or undefined when it does not look like what the field asks for. Light checks only: a typo guard, not an identity proof.
export function normalizeValue(f: Pick<FormField, "check" | "maxlength">, raw: string, today = new Date()): string | undefined {
	const v = raw.trim();
	if (!v || v.length > f.maxlength + 8) return undefined;
	switch (f.check) {
		case "text":
			return v.length <= f.maxlength ? v : undefined;
		case "phone":
			return /^\+?[\d\s().-]+$/.test(v) && digits(v).length >= 7 && digits(v).length <= 15 ? v : undefined;
		case "email":
			return v.length <= f.maxlength && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
		case "postal":
			return /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(v) ? v : undefined;
		case "luhn": {
			if (!/^[\d\s-]+$/.test(v)) return undefined;
			const n = digits(v);
			return n.length >= 12 && n.length <= 19 && luhn(n) ? n : undefined;
		}
		case "expiry": {
			const m = /^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/.exec(v);
			if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return undefined;
			return `${m[1]}/${m[2]!.slice(-2)}`;
		}
		case "cvc":
			return /^\d{3,4}$/.test(v) ? v : undefined;
		case "date": {
			const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/.exec(v);
			if (!m) return undefined;
			const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
			if (y < 1900 || !realDate(y, mo, d) || Date.UTC(y, mo - 1, d) > today.getTime()) return undefined;
			return `${m[1]}-${m[2]}-${m[3]}`;
		}
		case "id":
			return /^[A-Za-z0-9][A-Za-z0-9 -]{3,29}$/.test(v) ? v : undefined;
		case "account":
			return /^[A-Za-z0-9][A-Za-z0-9 -]{4,33}$/.test(v) ? v : undefined;
	}
}
