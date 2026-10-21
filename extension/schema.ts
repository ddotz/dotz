// Tool parameter schemas for hosts without `pi.zod`. omp hands extensions a zod instance; OmO (senpi) has none and takes
// plain JSON Schema (it validates non-TypeBox schemas as JSON Schema). This is the small zod-shaped subset the dotz tools
// use (object, string, number with min/max, boolean, enum, array, record, optional) building JSON Schema directly. A
// builder missing here throws while the extension loads, and OmO then drops every dotz tool of that session.
type Json = Record<string, unknown>;
export type Schema = { json: Json; isOptional: boolean; optional(): Schema; min(n: number): Schema; max(n: number): Schema };

const make = (json: Json, isOptional = false): Schema => ({
	json,
	isOptional,
	optional: () => make(json, true),
	min: (n: number) => make({ ...json, minimum: n }, isOptional),
	max: (n: number) => make({ ...json, maximum: n }, isOptional),
});

const toJson = (s: Schema | Json): Json => ("json" in s && typeof s.optional === "function" ? (s as Schema).json : (s as Json));

export const jsonZod = {
	string: () => make({ type: "string" }),
	number: () => make({ type: "number" }),
	boolean: () => make({ type: "boolean" }),
	enum: (values: readonly string[]) => make({ type: "string", enum: [...values] }),
	array: (item: Schema) => make({ type: "array", items: toJson(item) }),
	record: (_key: Schema, value: Schema) => make({ type: "object", additionalProperties: toJson(value) }),
	object: (shape: Record<string, Schema>) => {
		const properties = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toJson(v)]));
		const required = Object.entries(shape).filter(([, v]) => !v.isOptional).map(([k]) => k);
		return make({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
	},
};

// An object schema from the JSON Schema builder is unwrapped to plain JSON Schema where a tool is registered.
export const params = (schema: any) => (schema && typeof schema === "object" && "json" in schema && typeof schema.optional === "function" ? schema.json : schema);
