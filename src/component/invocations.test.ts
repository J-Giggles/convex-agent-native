import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import type { InvocationPersistence } from "../persistence/invocations.js";
import {
	verifyInvocationFailurePath,
	verifyInvocationSafetyInvariant,
} from "../test/invocation-conformance.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

const modules = {
	"./_generated/api.ts": () => import("./_generated/api.js"),
	"./_generated/dataModel.ts": () => import("./_generated/dataModel.js"),
	"./_generated/server.ts": () => import("./_generated/server.js"),
	"./audit.ts": () => import("./audit.js"),
	"./invocations.ts": () => import("./invocations.js"),
};

const binding = {
	actorId: "subject:one",
	requestFingerprint: `sha256:${"a".repeat(64)}`,
} as const;

function setup() {
	return convexTest(schema, modules);
}

function persistenceFor(t: ReturnType<typeof setup>): InvocationPersistence {
	const invocationId = (value: string) => value as Id<"invocations">;
	return {
		getInvocation: (input) =>
			t.query(api.invocations.get, {
				scopeKey: input.scopeKey,
				invocationId: invocationId(input.invocationId),
			}),
		claimInvocation: (input) => t.mutation(api.invocations.claim, input),
		completeInvocation: (input) =>
			t.mutation(api.invocations.complete, {
				...input,
				invocationId: invocationId(input.invocationId),
			}),
		failInvocation: (input) =>
			t.mutation(api.invocations.fail, {
				...input,
				invocationId: invocationId(input.invocationId),
			}),
	};
}

describe("native Convex invocation component", () => {
	it("CVX-N01 claims, settles, and reactively reads a scoped invocation", async () => {
		const t = setup();
		const claim = await t.mutation(api.invocations.claim, {
			scopeKey: "org:one",
			actionName: "increment-widget",
			idempotencyKey: "request-1",
			...binding,
			caller: "frontend",
		});
		expect(claim).toMatchObject({
			outcome: "claimed",
			invocation: { status: "running", scopeKey: "org:one" },
		});

		await expect(
			t.mutation(api.invocations.complete, {
				scopeKey: "org:one",
				invocationId: claim.invocation.id,
				result: { value: 2 },
			}),
		).resolves.toMatchObject({ status: "completed", result: { value: 2 } });
		await expect(
			t.query(api.invocations.get, {
				scopeKey: "org:one",
				invocationId: claim.invocation.id,
			}),
		).resolves.toMatchObject({ status: "completed", result: { value: 2 } });
		await expect(t.query(api.invocations.list, { scopeKey: "org:one" })).resolves.toHaveLength(1);
	});

	it("CVX-F01 hides reads and refuses settlement across scopes", async () => {
		const t = setup();
		const claim = await t.mutation(api.invocations.claim, {
			scopeKey: "org:one",
			actionName: "increment-widget",
			idempotencyKey: "request-2",
			...binding,
			caller: "mcp",
		});

		await expect(
			t.query(api.invocations.get, {
				scopeKey: "org:two",
				invocationId: claim.invocation.id,
			}),
		).resolves.toBeNull();
		await expect(
			t.mutation(api.invocations.complete, {
				scopeKey: "org:two",
				invocationId: claim.invocation.id,
				result: { value: 99 },
			}),
		).rejects.toThrow("Invocation not found");
	});

	it("CVX-I01 atomically replays one claim and never overwrites terminal state", async () => {
		const t = setup();
		const input = {
			scopeKey: "org:one",
			actionName: "invoice.approve",
			idempotencyKey: "request-3",
			...binding,
			caller: "automation" as const,
		};
		const first = await t.mutation(api.invocations.claim, input);
		await expect(t.mutation(api.invocations.claim, input)).resolves.toMatchObject({
			outcome: "in_flight",
			invocation: { id: first.invocation.id },
		});
		await t.mutation(api.invocations.complete, {
			scopeKey: input.scopeKey,
			invocationId: first.invocation.id,
			result: { value: 3 },
		});
		await expect(t.mutation(api.invocations.claim, input)).resolves.toMatchObject({
			outcome: "replay",
			invocation: { status: "completed", result: { value: 3 } },
		});
		await expect(
			t.mutation(api.invocations.complete, {
				scopeKey: input.scopeKey,
				invocationId: first.invocation.id,
				result: { value: 3 },
			}),
		).resolves.toMatchObject({ status: "completed", result: { value: 3 } });
		await expect(
			t.mutation(api.invocations.fail, {
				scopeKey: input.scopeKey,
				invocationId: first.invocation.id,
				errorCode: "LATE_FAILURE",
				errorMessage: "must not replace completion",
			}),
		).rejects.toThrow("already settled");
	});

	it("passes the shared invocation failure-path conformance", async () => {
		const t = setup();
		await verifyInvocationFailurePath({ createPersistence: () => persistenceFor(t) });
	});

	it("passes the shared invocation safety conformance", async () => {
		const t = setup();
		await verifyInvocationSafetyInvariant({ createPersistence: () => persistenceFor(t) });
	});

	it("stores bounded redacted failure data and secret-free derived audit rows", async () => {
		const t = setup();
		const claim = await t.mutation(api.invocations.claim, {
			scopeKey: "org:one",
			actionName: "increment-widget",
			idempotencyKey: "request-4",
			...binding,
			caller: "cli",
		});
		const failed = await t.mutation(api.invocations.fail, {
			scopeKey: "org:one",
			invocationId: claim.invocation.id,
			errorCode: "PROVIDER_FAILURE",
			errorMessage: `Bearer top-secret token=another-secret ${"x".repeat(2_000)}`,
		});
		expect(failed.errorMessage).not.toContain("top-secret");
		expect(failed.errorMessage).not.toContain("another-secret");
		expect(failed.errorMessage!.length).toBeLessThanOrEqual(1_036);

		const audit = await t.query(api.audit.listByInvocation, {
			scopeKey: "org:one",
			invocationId: claim.invocation.id,
		});
		expect(audit.map((event) => event.event)).toEqual(["claimed", "failed"]);
		expect(JSON.stringify(audit)).not.toMatch(
			/top-secret|another-secret|idempotencyKey|errorMessage|result/i,
		);
	});
});
