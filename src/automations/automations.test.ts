import { describe, expect, it, vi } from "vitest";

import {
	ConvexAutomationPersistence,
	assertAutomationScope,
	assertSafeAutomationPayload,
	automationPayloadDigest,
	automationPayloadIdentifier,
	createAutomationDraft,
	resolveAutomationAccess,
	type AutomationJobRecord,
	type AutomationRecord,
	type ConvexAutomationFunctions,
	type ConvexAutomationFunctionRunner,
} from "./index.js";

const access = resolveAutomationAccess({
	scopeKey: "org:acme",
	subjectId: "user:one",
	organizationId: "acme",
	role: "editor",
});

function functionRefs(): ConvexAutomationFunctions {
	return {
		getAutomation: "getAutomation" as never,
		listAutomations: "listAutomations" as never,
		saveAutomation: "saveAutomation" as never,
		listDueAutomations: "listDueAutomations" as never,
		getJob: "getJob" as never,
		claimJob: "claimJob" as never,
		heartbeatJob: "heartbeatJob" as never,
		settleJob: "settleJob" as never,
	};
}

describe("Convex durable automation state", () => {
	it("AUT-N01 saves an automation and atomically claims and settles one job", async () => {
		const draft = createAutomationDraft({
			id: "daily-summary",
			name: "Daily summary",
			instructions: "Prepare the reviewed daily summary.",
			trigger: { kind: "schedule", schedule: "0 8 * * *", nextRunAt: 10 },
			enabled: true,
			allowedActions: ["read-summary-data"],
		});
		const automation: AutomationRecord = {
			...draft,
			scopeKey: access.scopeKey,
			organizationId: "acme",
			createdBySubjectId: access.subjectId,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const running: AutomationJobRecord = {
			id: "job_1",
			scopeKey: access.scopeKey,
			automationId: automation.id,
			automationRevision: 1,
			idempotencyKey: "tick:2026-08-02",
			status: "running",
			input: { date: "2026-08-02" },
			attempt: 1,
			leaseToken: "lease_1",
			leaseExpiresAt: 1_000,
			createdAt: 2,
			updatedAt: 2,
		};
		const mutation = vi.fn(async (reference: unknown) => {
			if (reference === "saveAutomation") return automation;
			if (reference === "claimJob") {
				return { outcome: "claimed" as const, job: running };
			}
			if (reference === "settleJob") {
				return {
					...running,
					status: "succeeded" as const,
					output: { delivered: true },
					leaseToken: undefined,
					leaseExpiresAt: undefined,
					updatedAt: 3,
				};
			}
			throw new Error("unexpected mutation");
		});
		const persistence = new ConvexAutomationPersistence(
			{ query: vi.fn(), mutation } as unknown as ConvexAutomationFunctionRunner,
			functionRefs(),
		);

		await expect(persistence.saveAutomation(access, draft)).resolves.toEqual(automation);
		const claim = await persistence.claimJob(access, automation, {
			idempotencyKey: "tick:2026-08-02",
			input: { date: "2026-08-02" },
			leaseDurationMs: 30_000,
		});
		expect(claim).toMatchObject({ outcome: "claimed", job: { status: "running" } });
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await expect(
			persistence.settleJob(access, claim.job, {
				status: "succeeded",
				output: { delivered: true },
			}),
		).resolves.toMatchObject({ status: "succeeded" });
		expect(mutation).toHaveBeenCalledTimes(3);
	});

	it("AUT-F01 refuses cross-org, disabled, viewer, and unsafe operations", async () => {
		const other: AutomationRecord = {
			...createAutomationDraft({
				id: "other-org-job",
				name: "Other org",
				instructions: "Do reviewed work.",
				trigger: { kind: "event", event: "invoice.created" },
				enabled: true,
				allowedActions: [],
			}),
			scopeKey: "org:other",
			organizationId: "other",
			createdBySubjectId: "user:other",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		expect(() => assertAutomationScope(access, other)).toThrow(/scope/i);

		const mutation = vi.fn();
		const persistence = new ConvexAutomationPersistence(
			{ query: vi.fn(), mutation } as unknown as ConvexAutomationFunctionRunner,
			functionRefs(),
		);
		await expect(
			persistence.claimJob(
				access,
				{ ...other, scopeKey: access.scopeKey, organizationId: "acme", enabled: false },
				{ idempotencyKey: "one", input: {}, leaseDurationMs: 30_000 },
			),
		).rejects.toMatchObject({
			code: "INVALID_AUTOMATION",
		});
		expect(mutation).not.toHaveBeenCalled();

		const viewer = resolveAutomationAccess({
			scopeKey: access.scopeKey,
			subjectId: "user:viewer",
			organizationId: "acme",
			role: "viewer",
		});
		await expect(
			persistence.saveAutomation(
				viewer,
				createAutomationDraft({
					id: "denied",
					name: "Denied",
					instructions: "Do work.",
					trigger: { kind: "event", event: "invoice.created" },
					enabled: true,
					allowedActions: [],
				}),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(() => assertSafeAutomationPayload({ apiToken: "hidden" })).toThrow(/secret/i);
		expect(() => assertSafeAutomationPayload("x".repeat(70_000))).toThrow();
		expect(() =>
			assertSafeAutomationPayload({
				content: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			}),
		).toThrow(/payload/i);
		expect(() => assertSafeAutomationPayload({ value: 12_345_678 })).toThrow(
			/financial-identifier/i,
		);
		expect(() => assertSafeAutomationPayload({ value: "12345678" })).toThrow(/payload/i);
	});

	it("SEC-02 accepts purpose-typed identifiers and digests but refuses encoded durable content", () => {
		expect(() =>
			assertSafeAutomationPayload({
				legacyInvoiceId: "invoice-42",
				invoiceId: automationPayloadIdentifier("invoice", "invoice_42"),
				legacyRequestDigest: `sha256:${"b".repeat(64)}`,
				requestDigest: automationPayloadDigest("request", `sha256:${"b".repeat(64)}`),
			}),
		).not.toThrow();

		const narrative = "Invoice 43872 for GBP 920.00 from billing@example.test";
		for (const encoded of [
			Buffer.from(narrative).toString("base64"),
			Buffer.from(narrative).toString("base64url"),
			Buffer.from(narrative).toString("hex"),
			encodeURIComponent(narrative),
		]) {
			expect(() => assertSafeAutomationPayload({ nested: { neutral: encoded } })).toThrow(
				/payload/i,
			);
			expect(() => automationPayloadIdentifier("invoice", encoded)).toThrow(/payload/i);
			expect(() => assertSafeAutomationPayload({ invoiceId: encoded })).toThrow(/payload/i);
		}
		expect(() => assertSafeAutomationPayload({ nested: { neutral: "invoice_42" } })).toThrow(
			/payload/i,
		);
		expect(() => automationPayloadDigest("request", `sha256:${"z".repeat(64)}`)).toThrow(
			/payload/i,
		);
		expect(() =>
			assertSafeAutomationPayload({
				value: {
					$agentNative: "opaque-id",
					purpose: "invoice",
					value: "invoice_42",
					narrative,
				},
			}),
		).toThrow(/payload/i);
	});

	it("AUT-I01 replays one terminal job and rejects terminal re-settlement", async () => {
		const automation: AutomationRecord = {
			...createAutomationDraft({
				id: "once-only",
				name: "Once only",
				instructions: "Perform the bounded operation.",
				trigger: { kind: "event", event: "invoice.reviewed" },
				enabled: true,
				allowedActions: ["read-invoice"],
			}),
			scopeKey: access.scopeKey,
			organizationId: "acme",
			createdBySubjectId: access.subjectId,
			revision: 4,
			createdAt: 1,
			updatedAt: 1,
		};
		const terminal: AutomationJobRecord = {
			id: "job_terminal",
			scopeKey: access.scopeKey,
			automationId: automation.id,
			automationRevision: automation.revision,
			idempotencyKey: "event:42",
			status: "succeeded",
			output: { ok: true },
			attempt: 1,
			createdAt: 2,
			updatedAt: 3,
		};
		const mutation = vi.fn(async () => ({ outcome: "replay", job: terminal }));
		const persistence = new ConvexAutomationPersistence(
			{ query: vi.fn(), mutation } as unknown as ConvexAutomationFunctionRunner,
			functionRefs(),
		);

		await expect(
			persistence.claimJob(access, automation, {
				idempotencyKey: "event:42",
				input: { invoiceId: "invoice_42" },
				leaseDurationMs: 30_000,
			}),
		).resolves.toEqual({ outcome: "replay", job: terminal });
		await expect(
			persistence.settleJob(access, terminal, {
				status: "failed",
				errorCode: "LATE_FAILURE",
				errorMessage: "must not overwrite success",
			}),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(mutation).toHaveBeenCalledOnce();
	});
});
