import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createDrizzlePersistence, createDrizzlePersistenceSchema } from "./invocations.js";
import { drizzlePersistenceSchema } from "./schema.js";

describe("Drizzle invocation audit safety", () => {
	const clients: Database.Database[] = [];

	afterEach(() => {
		for (const client of clients.splice(0)) client.close();
	});

	function createPersistence() {
		const client = new Database(":memory:");
		clients.push(client);
		const database = drizzle(client, { schema: drizzlePersistenceSchema });
		createDrizzlePersistenceSchema(database);
		let now = 100;
		return createDrizzlePersistence(database, {
			generateId: () => "invocation-1",
			clock: () => ++now,
		});
	}

	it("records only allowlisted lifecycle fields in the settlement transaction", async () => {
		const persistence = createPersistence();
		const claim = await persistence.invocations.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "invoice.approve",
			idempotencyKey: "secret-request-key",
			actorId: "subject:alpha",
			requestFingerprint: `sha256:${"a".repeat(64)}`,
			caller: "tool",
		});
		const completed = await persistence.invocations.completeInvocation({
			scopeKey: "org:alpha",
			invocationId: claim.invocation.id,
			result: { approved: true },
		});
		expect(completed.result).toEqual({ approved: true });

		const events = await persistence.audit.listInvocationAuditEvents({
			scopeKey: "org:alpha",
			invocationId: claim.invocation.id,
		});
		expect(events.map(({ event }) => event)).toEqual(["claimed", "completed"]);
		expect(JSON.stringify(events)).not.toContain("secret-request-key");
		await expect(
			persistence.audit.listInvocationAuditEvents({
				scopeKey: "org:beta",
				invocationId: claim.invocation.id,
			}),
		).resolves.toEqual([]);
	});

	it("does not settle or audit an invalid stable error code", async () => {
		const persistence = createPersistence();
		const claim = await persistence.invocations.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "invoice.approve",
			idempotencyKey: "request-2",
			actorId: "subject:alpha",
			requestFingerprint: `sha256:${"b".repeat(64)}`,
			caller: "tool",
		});

		await expect(
			persistence.invocations.failInvocation({
				scopeKey: "org:alpha",
				invocationId: claim.invocation.id,
				errorCode: "token=must-not-enter-audit",
				errorMessage: "Bearer must-not-enter-audit",
			}),
		).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
		await expect(
			persistence.invocations.getInvocation({
				scopeKey: "org:alpha",
				invocationId: claim.invocation.id,
			}),
		).resolves.toMatchObject({ status: "running" });
		await expect(
			persistence.audit.listInvocationAuditEvents({
				scopeKey: "org:alpha",
				invocationId: claim.invocation.id,
			}),
		).resolves.toHaveLength(1);
	});
});
