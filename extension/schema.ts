// Tool parameter schemas for hosts without `pi.zod`. omp hands extensions a zod instance; OmO (senpi) has none and takes
// plain JSON Schema (it validates non-TypeBox schemas as JSON Schema). This is the small zod-shaped subset the dotz tools
// use (object, string, number with min/max, boolean, enum, array, optional) building JSON Schema directly.
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
	object: (shape: Record<string, Schema>) => {
		const properties = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toJson(v)]));
		const required = Object.entries(shape).filter(([, v]) => !v.isOptional).map(([k]) => k);
		return make({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
	},
};

// The zod omp provides, else the JSON Schema builder; an object schema from the builder is unwrapped to plain JSON Schema
// where a tool is registered (see params()).
export const schemaOf = (pi: any) => (pi?.zod ?? jsonZod) as any;
export const params = (schema: any) => (schema && typeof schema === "object" && "json" in schema && typeof schema.optional === "function" ? schema.json : schema);
