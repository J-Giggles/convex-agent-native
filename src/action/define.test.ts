import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";

import { defineConvexAction } from "./define.js";

function schema<T>(validate: (value: unknown) => T | null): StandardSchemaV1<unknown, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "test",
			validate(value) {
				const parsed = validate(value);
				return parsed === null ? { issues: [{ message: "invalid" }] } : { value: parsed };
			},
		},
	};
}

describe("Convex-safe Builder action definition", () => {
	it("CVX-N-002 preserves the public action contract and strict output validation", async () => {
		const definition = defineConvexAction({
			description: "Echo a bounded value",
			schema: schema<{ value: string }>((value) =>
				value &&
				typeof value === "object" &&
				typeof (value as { value?: unknown }).value === "string"
					? { value: (value as { value: string }).value.trim() }
					: null,
			),
			toolParameters: {
				type: "object",
				properties: { value: { type: "string", minLength: 1 } },
				required: ["value"],
			},
			outputSchema: schema<{ echoed: string }>((value) =>
				value &&
				typeof value === "object" &&
				typeof (value as { echoed?: unknown }).echoed === "string"
					? { echoed: (value as { echoed: string }).echoed }
					: null,
			),
			outputErrorStrategy: "strict",
			audit: { enabled: false },
			publicAgent: { expose: true, readOnly: true },
			readOnly: true,
			run: ({ value }) => ({ echoed: value }),
		});

		expect(definition.tool).toEqual({
			description: "Echo a bounded value",
			parameters: expect.objectContaining({ type: "object" }),
		});
		await expect(definition.run({ value: "  hello  " }, { caller: "mcp" })).resolves.toEqual({
			echoed: "hello",
		});
	});

	it("CVX-F-003 refuses invalid input before the action handler runs", async () => {
		let handlerCalls = 0;
		const definition = defineConvexAction({
			description: "Accept a string",
			schema: schema<{ value: string }>((value) =>
				value &&
				typeof value === "object" &&
				typeof (value as { value?: unknown }).value === "string"
					? { value: (value as { value: string }).value }
					: null,
			),
			toolParameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
			run: ({ value }) => {
				handlerCalls += 1;
				return value;
			},
		});

		await expect(definition.run({ value: 42 } as never, { caller: "mcp" })).rejects.toThrow(
			"Action input did not match schema",
		);
		expect(handlerCalls).toBe(0);
	});

	it("CVX-F-002 fails closed when the declared output contract is violated", async () => {
		const definition = defineConvexAction({
			description: "Return an invalid value",
			schema: schema<Record<string, never>>((value) =>
				value && typeof value === "object" ? {} : null,
			),
			toolParameters: { type: "object", properties: {} },
			outputSchema: schema<{ ok: true }>((value) =>
				value && typeof value === "object" && (value as { ok?: unknown }).ok === true
					? { ok: true }
					: null,
			),
			outputErrorStrategy: "strict",
			audit: { enabled: false },
			readOnly: true,
			run: () => ({ ok: false as const }),
		});

		await expect(definition.run({}, { caller: "mcp" })).rejects.toThrow(
			"Action output did not match outputSchema",
		);
	});
});
