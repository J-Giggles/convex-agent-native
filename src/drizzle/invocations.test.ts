import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import {
	verifyInvocationFailurePath,
	verifyInvocationNormalPath,
	verifyInvocationSafetyInvariant,
} from "../test/invocation-conformance.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import {
	createDrizzleInvocationPersistence,
	createDrizzlePersistenceSchema,
} from "./invocations.js";
import { drizzlePersistenceSchema } from "./schema.js";

function createPersistence() {
	const sqlite = new Database(":memory:");
	const database = drizzle(sqlite, { schema: drizzlePersistenceSchema });
	createDrizzlePersistenceSchema(database);
	let id = 0;
	let now = 1_700_000_000_000;
	return createDrizzleInvocationPersistence(database, {
		generateId: () => `invocation-${++id}`,
		clock: () => ++now,
	});
}

function createHarnessPersistence(): InvocationPersistence {
	const persistence = createPersistence();
	return {
		...persistence,
		claimInvocation: (input) =>
			persistence.claimInvocation({
				...input,
				actorId: input.actorId ?? "subject:conformance",
				requestFingerprint: input.requestFingerprint ?? `sha256:${"c".repeat(64)}`,
			}),
	};
}

describe("Drizzle invocation persistence", () => {
	it("PER-N01 claims, completes, and replays an invocation", async () => {
		await verifyInvocationNormalPath({ createPersistence: createHarnessPersistence });
	});

	it("persists and replays a failed invocation", async () => {
		await verifyInvocationFailurePath({ createPersistence: createHarnessPersistence });
	});

	it("PER-F01 returns a typed failure and rolls back an atomic claim", async () => {
		const sqlite = new Database(":memory:");
		try {
			const database = drizzle(sqlite, { schema: drizzlePersistenceSchema });
			createDrizzlePersistenceSchema(database);
			sqlite.exec("DROP TABLE agent_native_invocation_audit_events");
			const persistence = createDrizzleInvocationPersistence(database, {
				generateId: () => "invocation-1",
				clock: () => 1_700_000_000_001,
			});

			await expect(
				persistence.claimInvocation({
					scopeKey: "org:alpha",
					actionName: "invoice.approve",
					idempotencyKey: "request-rollback",
					actorId: "subject:alpha",
					requestFingerprint: `sha256:${"a".repeat(64)}`,
					caller: "tool",
				}),
			).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });

			createDrizzlePersistenceSchema(database);
			await expect(
				persistence.getInvocation({
					scopeKey: "org:alpha",
					invocationId: "invocation-1",
				}),
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it("PER-I01 isolates scopes and preserves terminal state", async () => {
		await verifyInvocationSafetyInvariant({
			createPersistence: createHarnessPersistence,
		});
	});

	it("binds an idempotency key to its actor and request fingerprint", async () => {
		const persistence = createPersistence();
		const first = await persistence.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "invoice.approve",
			idempotencyKey: "request-conflict",
			actorId: "subject:alpha",
			requestFingerprint: `sha256:${"a".repeat(64)}`,
			caller: "tool",
		});
		const changedRequest = await persistence.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "invoice.approve",
			idempotencyKey: "request-conflict",
			actorId: "subject:alpha",
			requestFingerprint: `sha256:${"b".repeat(64)}`,
			caller: "tool",
		});
		const changedActor = await persistence.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "invoice.approve",
			idempotencyKey: "request-conflict",
			actorId: "subject:beta",
			requestFingerprint: `sha256:${"a".repeat(64)}`,
			caller: "tool",
		});

		expect(first.outcome).toBe("claimed");
		expect(changedRequest).toMatchObject({
			outcome: "conflict",
			invocation: { id: first.invocation.id },
		});
		expect(changedActor).toMatchObject({
			outcome: "conflict",
			invocation: { id: first.invocation.id },
		});
	});
});
