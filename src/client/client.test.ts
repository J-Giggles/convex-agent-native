import { describe, expect, it, vi } from "vitest";

import { createActionClient } from "./index.js";

describe("client action adapter", () => {
	it("CLIEN-N01 sends only action input and idempotency metadata", async () => {
		const transport = vi.fn(async () => ({ replayed: false, result: { value: 2 } }));
		const client = createActionClient(transport);

		await expect(
			client.callAction("increment-widget", { amount: 1 }, { idempotencyKey: "k1" }),
		).resolves.toEqual({ replayed: false, result: { value: 2 } });
		expect(transport).toHaveBeenCalledWith({
			actionName: "increment-widget",
			input: { amount: 1 },
			idempotencyKey: "k1",
		});
	});

	it("CLIEN-F01 preserves a typed transport rejection", async () => {
		const rejection = Object.assign(new Error("denied"), { code: "FORBIDDEN" });
		const client = createActionClient(async () => Promise.reject(rejection));
		await expect(client.callAction("private", {})).rejects.toBe(rejection);
	});

	it("CLIEN-I01 has no client scope field", () => {
		const client = createActionClient(async (request) => ({
			replayed: false,
			result: request,
		}));
		expect(JSON.stringify(client)).not.toContain("scopeKey");
	});
});
