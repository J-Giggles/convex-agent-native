import type { StandardSchemaV1 } from "@standard-schema/spec";

interface FieldSchema<T> {
	readonly validate: (value: unknown) => value is T;
}

interface NumberFieldSchema extends FieldSchema<number> {
	int(): NumberFieldSchema;
	min(minimum: number): NumberFieldSchema;
	max(maximum: number): NumberFieldSchema;
}

type FieldOutput<TField> = TField extends FieldSchema<infer TOutput> ? TOutput : never;

function numberField(
	options: {
		readonly integer?: boolean;
		readonly minimum?: number;
		readonly maximum?: number;
	} = {},
): NumberFieldSchema {
	return Object.freeze({
		validate: (value: unknown): value is number =>
			typeof value === "number" &&
			Number.isFinite(value) &&
			(options.integer !== true || Number.isInteger(value)) &&
			(options.minimum === undefined || value >= options.minimum) &&
			(options.maximum === undefined || value <= options.maximum),
		int: () => numberField({ ...options, integer: true }),
		min: (minimum: number) => numberField({ ...options, minimum }),
		max: (maximum: number) => numberField({ ...options, maximum }),
	});
}

function objectSchema<TFields extends Readonly<Record<string, FieldSchema<unknown>>>>(
	fields: TFields,
): StandardSchemaV1<unknown, { [TKey in keyof TFields]: FieldOutput<TFields[TKey]> }> {
	type Output = { [TKey in keyof TFields]: FieldOutput<TFields[TKey]> };
	return Object.freeze({
		"~standard": Object.freeze({
			version: 1 as const,
			vendor: "agent-native-convex-test",
			validate(value: unknown): StandardSchemaV1.Result<Output> {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					return { issues: [{ message: "Expected an object" }] };
				}
				const input = value as Record<string, unknown>;
				const output: Record<string, unknown> = {};
				for (const [key, field] of Object.entries(fields)) {
					if (!field.validate(input[key])) {
						return { issues: [{ message: `Invalid field ${key}`, path: [key] }] };
					}
					output[key] = input[key];
				}
				return { value: output as Output };
			},
		}),
	});
}

/** Small dependency-free Standard Schema builder for adapter conformance tests. */
export const testSchema = Object.freeze({
	string: (): FieldSchema<string> =>
		Object.freeze({
			validate: (value: unknown): value is string => typeof value === "string",
		}),
	number: (): NumberFieldSchema => numberField(),
	object: objectSchema,
});
