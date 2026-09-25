type JsonSchemaObject = Record<string, unknown>;

/** Keywords the major model providers reject inside a tool parameter schema. */
const PROVIDER_REJECTED_KEYWORDS = [
	"propertyNames",
	"patternProperties",
	"dependentSchemas",
	"dependentRequired",
	"if",
	"then",
	"else",
	"not",
] as const;

const PROVIDER_SUPPORTED_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"ipv4",
	"ipv6",
	"uuid",
]);

const LOOKAROUND_IN_PATTERN = /\(\?<?[=!]/u;
const SUBSCHEMA_VALUE_KEYS = ["items", "additionalItems", "contains", "additionalProperties"] as const;
const SUBSCHEMA_ARRAY_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SUBSCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"] as const;
const ROOT_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

function isSchemaObject(value: unknown): value is JsonSchemaObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function stripUnsupportedKeywords(node: unknown): void {
	if (!isSchemaObject(node)) return;
	for (const keyword of PROVIDER_REJECTED_KEYWORDS) delete node[keyword];
	if (typeof node.format === "string" && !PROVIDER_SUPPORTED_FORMATS.has(node.format)) {
		delete node.format;
	}
	if (typeof node.pattern === "string" && LOOKAROUND_IN_PATTERN.test(node.pattern)) {
		delete node.pattern;
	}
	for (const key of SUBSCHEMA_VALUE_KEYS) {
		const value = node[key];
		if (Array.isArray(value)) value.forEach(stripUnsupportedKeywords);
		else stripUnsupportedKeywords(value);
	}
	for (const key of SUBSCHEMA_ARRAY_KEYS) {
		const value = node[key];
		if (Array.isArray(value)) value.forEach(stripUnsupportedKeywords);
	}
	for (const key of SUBSCHEMA_MAP_KEYS) {
		const value = node[key];
		if (isSchemaObject(value)) Object.values(value).forEach(stripUnsupportedKeywords);
	}
	// Providers accept `anyOf` where they reject `oneOf`; merge rather than drop.
	if (Array.isArray(node.oneOf)) {
		const existing = Array.isArray(node.anyOf) ? node.anyOf : [];
		node.anyOf = [...existing, ...node.oneOf];
		delete node.oneOf;
	}
}

interface ObjectPart {
	properties: JsonSchemaObject;
	required: string[];
	closed: boolean;
}

function partOf(schema: JsonSchemaObject): ObjectPart {
	return {
		properties: isSchemaObject(schema.properties) ? schema.properties : {},
		required: Array.isArray(schema.required)
			? schema.required.filter((key): key is string => typeof key === "string")
			: [],
		closed: schema.additionalProperties === false,
	};
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function combine(schemas: unknown[], keyword: "allOf" | "anyOf"): unknown {
	const variants: unknown[] = [];
	for (const schema of schemas) {
		const arms =
			isSchemaObject(schema) && Object.keys(schema).length === 1 && Array.isArray(schema[keyword])
				? schema[keyword]
				: [schema];
		for (const variant of arms) {
			if (keyword === "allOf" && (variant === true || same(variant, {}))) continue;
			if (!variants.some((known) => same(known, variant))) variants.push(variant);
		}
	}
	if (variants.length === 0) return {};
	return variants.length === 1 ? variants[0] : { [keyword]: variants };
}

function mergeProperties(parts: ObjectPart[], keyword: "allOf" | "anyOf"): JsonSchemaObject {
	const grouped = new Map<string, unknown[]>();
	for (const part of parts) {
		for (const [key, schema] of Object.entries(part.properties)) {
			grouped.set(key, [...(grouped.get(key) ?? []), schema]);
		}
	}
	const merged: JsonSchemaObject = {};
	for (const [key, schemas] of grouped) merged[key] = combine(schemas, keyword);
	return merged;
}

function conjoin(parts: ObjectPart[]): ObjectPart {
	return {
		properties: mergeProperties(parts, "allOf"),
		required: [...new Set(parts.flatMap((part) => part.required))],
		closed: parts.some((part) => part.closed),
	};
}

function disjoin(parts: ObjectPart[]): ObjectPart {
	return {
		properties: mergeProperties(parts, "anyOf"),
		required: (parts[0]?.required ?? []).filter((key) =>
			parts.every((part) => part.required.includes(key)),
		),
		closed: parts.every((part) => part.closed),
	};
}

/**
 * Collapse a root `allOf`/`anyOf`/`oneOf` into one object schema, following the
 * upstream 0.187 rule: the root's own keywords and each composition are
 * conjuncts; inside a disjunction a property declared differently by several
 * branches becomes an `anyOf`, `required` keeps only keys every branch requires
 * and the object is closed only when every branch is; inside a conjunction a
 * repeated property becomes an `allOf`, `required` is the union and any closed
 * conjunct closes the result. Nested compositions flatten first. The result
 * over-approximates the original; the Standard Schema remains the gate.
 */
function flattenRootCombinator(root: JsonSchemaObject): JsonSchemaObject {
	const compositions = ROOT_COMBINATORS.filter((key) => Array.isArray(root[key]));
	if (compositions.length === 0) return root;
	const parts = [partOf(root)];
	for (const composition of compositions) {
		const branches = (root[composition] as unknown[]).map((branch) =>
			partOf(isSchemaObject(branch) ? flattenRootCombinator(branch) : {}),
		);
		if (branches.length === 0) continue;
		parts.push(composition === "allOf" ? conjoin(branches) : disjoin(branches));
	}
	const merged = conjoin(parts);
	const rest = { ...root };
	for (const key of ROOT_COMBINATORS) delete rest[key];
	return {
		...rest,
		type: "object",
		properties: merged.properties,
		required: merged.required.filter((key) => key in merged.properties).sort(),
		...(merged.closed ? { additionalProperties: false } : {}),
	};
}

/**
 * Advertised tool parameters for model-facing surfaces: a deep copy of the
 * declared JSON Schema with provider-rejected keywords removed, `oneOf`
 * rewritten to `anyOf`, and a composed root collapsed to one object schema.
 * The declared Standard Schema stays the runtime validation authority.
 */
export function normalizeToolParameters(
	parameters: object | undefined,
): JsonSchemaObject & { type: "object" } {
	const root: JsonSchemaObject = cloneJson(parameters as JsonSchemaObject | undefined) ?? {
		properties: {},
	};
	stripUnsupportedKeywords(root);
	const flattened = flattenRootCombinator(root);
	return {
		...flattened,
		type: "object",
		...(isSchemaObject(flattened.properties) ? {} : { properties: {} }),
	};
}
