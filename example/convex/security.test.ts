import type { UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "./_generated/api.js";
import { deriveHostScope } from "./auth.js";
import schema from "./schema.js";

const identity = {
	tokenIdentifier: "https://id.example.test#user-1",
	issuer: "https://id.example.test",
	subject: "user-1",
	organization_id: "acme",
} as UserIdentity;

const modules = {
	"./_generated/api.ts": () => import("./_generated/api.js"),
	"./_generated/dataModel.ts": () => import("./_generated/dataModel.js"),
	"./_generated/server.ts": () => import("./_generated/server.js"),
	"./rateLimit.ts": () => import("./rateLimit.js"),
};

describe("generated example security boundary", () => {
	it("derives collision-resistant organization scope from verified authority", () => {
		const scope = deriveHostScope(identity);
		expect(scope).toMatchObject({
			organizationId: "acme",
			scopeKey: "organization:https%3A%2F%2Fid.example.test:acme",
			subjectId: "https%3A%2F%2Fid.example.test#user-1",
		});
		expect(
			deriveHostScope({ ...identity, issuer: "https://other-id.example.test" }).scopeKey,
		).not.toBe(scope.scopeKey);
	});

	it("fails closed when issuer, subject, or organization authority is absent", () => {
		for (const candidate of [
			{ ...identity, issuer: "" },
			{ ...identity, subject: "" },
			{ ...identity, organization_id: undefined },
		]) {
			expect(() => deriveHostScope(candidate as UserIdentity)).toThrow(/Authenticated/u);
		}
	});

	it("keeps rate policy server-owned and atomically refuses excess calls", async () => {
		const t = convexTest(schema, modules);
		const request = { scopeKey: "organization:issuer:acme", operation: "create-thread" as const };
		for (let index = 0; index < 10; index += 1) {
			await t.mutation(internal.rateLimit.consumeActionRateLimit, request);
		}
		await expect(t.mutation(internal.rateLimit.consumeActionRateLimit, request)).rejects.toThrow(
			"Rate limit exceeded",
		);
		await expect(t.run((ctx) => ctx.db.query("rateLimits").collect())).resolves.toMatchObject([
			{ count: 10 },
		]);
	});
});
