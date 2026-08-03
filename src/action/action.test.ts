import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { AgentNativeConvexError } from "../contracts/error.js";
import { resolveActionScope } from "../contracts/scope.js";
import type {
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import { executeRegisteredAction } from "./execute.js";
import { readActionExecutionContext } from "./execution-context.js";
import { ActionRegistry } from "./registry.js";
import {
	actionReplayDigest,
	actionReplayIdentifier,
	assertSafePersistedValue,
	sanitizePersistedValue,
} from "./sanitize.js";

class MemoryInvocations implements InvocationPersistence {
	readonly records = new Map<string, InvocationRecord>();
	nextId = 1;

	async claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		const key = `${input.scopeKey}:${input.actionName}:${input.idempotencyKey}`;
		const current = this.records.get(key);
		if (current) {
			if (
				current.actorId !== input.actorId ||
				current.requestFingerprint !== input.requestFingerprint ||
				current.caller !== input.caller
			) {
				return { outcome: "conflict", invocation: current };
			}
			return {
				outcome: current.status === "running" ? "in_flight" : "replay",
				invocation: current,
			};
		}
		const now = Date.now();
		const invocation: InvocationRecord = {
			id: `inv_${this.nextId++}`,
			...input,
			status: "running",
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(key, invocation);
		return { outcome: "claimed", invocation };
	}

	async getInvocation(input: {
		scopeKey: string;
		invocationId: string;
	}): Promise<InvocationRecord | null> {
		return (
			[...this.records.values()].find(
				(record) => record.scopeKey === input.scopeKey && record.id === input.invocationId,
			) ?? null
		);
	}

	async completeInvocation(input: {
		scopeKey: string;
		invocationId: string;
		result: unknown;
	}): Promise<InvocationRecord> {
		const record = await this.getInvocation(input);
		if (!record) throw new Error("not found");
		Object.assign(record, {
			status: "completed" as const,
			result: input.result,
			updatedAt: Date.now(),
		});
		return record;
	}

	async failInvocation(input: {
		scopeKey: string;
		invocationId: string;
		errorCode: string;
		errorMessage: string;
	}): Promise<InvocationRecord> {
		const record = await this.getInvocation(input);
		if (!record) throw new Error("not found");
		Object.assign(record, {
			status: "failed" as const,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			updatedAt: Date.now(),
		});
		return record;
	}
}

const scope = resolveActionScope({ scopeKey: "org:acme", subjectId: "user:1" });

describe("action registry and execution", () => {
	it("ACT-N06 supplies host-owned execution data to one reusable action definition", async () => {
		const hostContext = { store: "trusted" };
		const action = defineAction({
			description: "Read host execution data",
			schema: z.object({}),
			audit: { enabled: false },
			readOnly: true,
			run: (_input, context) => readActionExecutionContext(context),
		});
		const registry = new ActionRegistry().register("read-host-context", action);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "read-host-context",
				input: { executionContext: "attacker" },
				caller: "frontend",
				scope,
				executionContext: hostContext,
			}),
		).resolves.toMatchObject({ result: hostContext });
	});
	it("ACT-N01 validates and executes an official action definition", async () => {
		const run = vi.fn(({ amount }: { amount: number }) => ({ value: amount + 1 }));
		const action = defineAction({
			description: "Increment a value",
			schema: z.object({ amount: z.number().int() }),
			outputSchema: z.object({ value: z.number().int() }),
			outputErrorStrategy: "strict",
			audit: { enabled: false },
			run,
		});
		const registry = new ActionRegistry().register("increment-widget", action, {
			authorizeBeforeClaim: () => true,
			projectReplayResult: (result) => result,
		});
		const persistence = new MemoryInvocations();

		const result = await executeRegisteredAction(registry, persistence, {
			actionName: "increment-widget",
			input: { amount: 2 },
			caller: "frontend",
			scope,
			idempotencyKey: "request-1",
		});

		expect(result).toMatchObject({ replayed: false, result: { value: 3 } });
		expect(run).toHaveBeenCalledOnce();
	});

	it("requires approval for every consequential public action", async () => {
		const handler = vi.fn(() => ({ ok: true }));
		const registry = new ActionRegistry().register(
			"consequential-action",
			defineAction({
				description: "Consequential write",
				schema: z.object({}),
				publicAgent: { expose: true, readOnly: false, isConsequential: true },
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "consequential-action",
				input: {},
				caller: "frontend",
				scope,
				idempotencyKey: "consequential-1",
			}),
		).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("refuses output schemas that use the upstream fail-open default", async () => {
		const handler = vi.fn(() => ({ value: "wrong" }));
		const registry = new ActionRegistry().register(
			"unsafe-output",
			defineAction({
				description: "Unsafe output policy",
				schema: z.object({}),
				outputSchema: z.object({ value: z.number() }),
				readOnly: true,
				run: handler,
			}),
		);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "unsafe-output",
				input: {},
				caller: "frontend",
				scope,
			}),
		).rejects.toMatchObject({ code: "UNSAFE_ACTION_DEFINITION" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("maps strict output validation failures to a stable durable code", async () => {
		const persistence = new MemoryInvocations();
		const registry = new ActionRegistry().register(
			"invalid-output",
			defineAction({
				description: "Strict invalid output",
				schema: z.object({}),
				outputSchema: z.object({ value: z.number() }),
				outputErrorStrategy: "strict",
				audit: { enabled: false },
				run: () => ({ value: "wrong" }),
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);

		await expect(
			executeRegisteredAction(registry, persistence, {
				actionName: "invalid-output",
				input: {},
				caller: "frontend",
				scope,
				idempotencyKey: "invalid-output-1",
			}),
		).rejects.toMatchObject({ code: "ACTION_OUTPUT_INVALID" });
		expect([...persistence.records.values()][0]).toMatchObject({
			status: "failed",
			errorCode: "ACTION_OUTPUT_INVALID",
		});
	});

	it("SEC-04 refuses forged extension provenance at the generic action boundary", async () => {
		const persistence = new MemoryInvocations();
		const needsApproval = vi.fn(() => false);
		const authorizeBeforeClaim = vi.fn((_input, context) => context.caller === "extension");
		const handler = vi.fn((_input, context) => ({ contextCaller: context?.caller }));
		const registry = new ActionRegistry().register(
			"extension-write",
			defineAction({
				description: "Extension bridge write",
				schema: z.object({}),
				toolCallable: true,
				needsApproval,
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim,
				projectReplayResult: () => ({ ok: true }),
			},
		);

		await expect(
			executeRegisteredAction(registry, persistence, {
				actionName: "extension-write",
				input: {},
				caller: "extension",
				scope,
				idempotencyKey: "extension-1",
			}),
		).rejects.toMatchObject({ code: "ACTION_NOT_AUTHORIZED" });
		expect(persistence.records.size).toBe(0);
		expect(authorizeBeforeClaim).not.toHaveBeenCalled();
		expect(needsApproval).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();

		const hidden = new ActionRegistry().register(
			"hidden-extension-write",
			defineAction({
				description: "Hidden write",
				schema: z.object({}),
				audit: { enabled: false },
				run: () => ({ ok: true }),
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);
		await expect(
			executeRegisteredAction(hidden, new MemoryInvocations(), {
				actionName: "hidden-extension-write",
				input: {},
				caller: "extension",
				scope,
				idempotencyKey: "extension-hidden",
			}),
		).rejects.toMatchObject({ code: "ACTION_NOT_AUTHORIZED" });
	});

	it("ACT-F01 refuses invalid input before the handler body", async () => {
		const handler = vi.fn(() => ({ ok: true }));
		const registry = new ActionRegistry().register(
			"validated-action",
			defineAction({
				description: "Requires a number",
				schema: z.object({ amount: z.number() }),
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "validated-action",
				input: { amount: "not-a-number" },
				caller: "frontend",
				scope,
				idempotencyKey: "bad-input",
			}),
		).rejects.toThrow();
		expect(handler).not.toHaveBeenCalled();
	});

	it("refuses unauthorized input before reserving an idempotency key", async () => {
		const persistence = new MemoryInvocations();
		const handler = vi.fn(() => ({ ok: true }));
		const registry = new ActionRegistry().register(
			"authorized-write",
			defineAction({
				description: "Authorized write",
				schema: z.object({ amount: z.number() }),
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => false,
				projectReplayResult: ({ ok }) => ({ ok }),
			},
		);

		await expect(
			executeRegisteredAction(registry, persistence, {
				actionName: "authorized-write",
				input: { amount: 1 },
				caller: "frontend",
				scope,
				idempotencyKey: "not-reserved",
			}),
		).rejects.toMatchObject({ code: "ACTION_NOT_AUTHORIZED" });
		expect(handler).not.toHaveBeenCalled();
		expect(persistence.records.size).toBe(0);
	});

	it("ACT-F01 refuses missing approval and surface exposure", async () => {
		const registry = new ActionRegistry()
			.register(
				"approved-action",
				defineAction({
					description: "Consequential write",
					schema: z.object({}),
					needsApproval: true,
					audit: { enabled: false },
					run: () => ({ ok: true }),
				}),
				{
					authorizeBeforeClaim: () => true,
					projectReplayResult: (result) => result,
				},
			)
			.register(
				"private-action",
				defineAction({
					description: "Private read",
					schema: z.object({}),
					readOnly: true,
					run: () => ({ ok: true }),
				}),
			);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "approved-action",
				input: {},
				caller: "frontend",
				scope,
				idempotencyKey: "approval-1",
			}),
		).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "private-action",
				input: {},
				caller: "mcp",
				scope,
			}),
		).rejects.toMatchObject({ code: "ACTION_NOT_EXPOSED" });
	});

	it("ACT-I01 replays one durable result and does not repeat the handler", async () => {
		const handler = vi.fn(() => ({ ok: true, accessToken: "secret-value" }));
		const registry = new ActionRegistry().register(
			"once-only",
			defineAction({
				description: "One write",
				schema: z.object({}),
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: ({ ok }) => ({ ok }),
			},
		);
		const persistence = new MemoryInvocations();
		const request = {
			actionName: "once-only",
			input: {},
			caller: "frontend" as const,
			scope,
			idempotencyKey: "same-key",
		};

		const first = await executeRegisteredAction(registry, persistence, request);
		const second = await executeRegisteredAction(registry, persistence, request);

		expect(first.replayed).toBe(false);
		expect(second).toMatchObject({ replayed: true });
		expect(handler).toHaveBeenCalledOnce();
		const persisted = [...persistence.records.values()][0];
		expect(persisted?.result).toEqual({ ok: true });
	});

	it("binds replay and approval to the exact actor and validated request", async () => {
		const handler = vi.fn(({ amount }: { amount: number }) => ({ ok: true, amount }));
		const registry = new ActionRegistry().register(
			"bound-write",
			defineAction({
				description: "Bound write",
				schema: z.object({ amount: z.number() }),
				needsApproval: true,
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: ({ ok, amount }) => ({ ok, amount }),
			},
		);
		const persistence = new MemoryInvocations();
		const unusedGrants = new Set(["valid-once", "valid-two"]);
		const approvalVerifier = {
			verifyAndConsume: vi.fn(async (grant) => {
				const valid =
					unusedGrants.has(grant.approvalGrant) &&
					grant.actorId === "user:1" &&
					grant.scopeKey === "org:acme" &&
					grant.actionName === "bound-write" &&
					grant.requestFingerprint.startsWith("sha256:");
				if (valid) unusedGrants.delete(grant.approvalGrant);
				return valid;
			}),
		};

		await expect(
			executeRegisteredAction(
				registry,
				persistence,
				{
					actionName: "bound-write",
					input: { amount: 10 },
					caller: "frontend",
					scope,
					idempotencyKey: "forged-key",
					approvedToolCallKey: "forged",
				},
				{ approvalVerifier },
			),
		).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

		await executeRegisteredAction(
			registry,
			persistence,
			{
				actionName: "bound-write",
				input: { amount: 10 },
				caller: "frontend",
				scope,
				idempotencyKey: "bound-key",
				approvedToolCallKey: "valid-once",
			},
			{ approvalVerifier },
		);

		await expect(
			executeRegisteredAction(
				registry,
				persistence,
				{
					actionName: "bound-write",
					input: { amount: 10 },
					caller: "frontend",
					scope,
					idempotencyKey: "bound-key",
					approvedToolCallKey: "valid-once",
				},
				{ approvalVerifier },
			),
		).resolves.toMatchObject({ replayed: true });

		await expect(
			executeRegisteredAction(
				registry,
				persistence,
				{
					actionName: "bound-write",
					input: { amount: 11 },
					caller: "frontend",
					scope,
					idempotencyKey: "bound-key",
					approvedToolCallKey: "valid-two",
				},
				{ approvalVerifier },
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});

	it("requires host-resolved scope rather than trusting a transport object", async () => {
		const registry = new ActionRegistry().register(
			"scoped-read",
			defineAction({
				description: "Scoped read",
				schema: z.object({}),
				readOnly: true,
				run: () => ({ ok: true }),
			}),
		);

		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "scoped-read",
				input: {},
				caller: "frontend",
				scope: { scopeKey: "org:forged", subjectId: "attacker" } as never,
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentNativeConvexError>>({
				code: "INVALID_SCOPE",
			}),
		);
	});
});

describe("persisted result sanitization", () => {
	it("redacts secret-shaped keys and bounds nested strings", () => {
		const result = sanitizePersistedValue({
			token: "secret",
			nested: { password: "secret", safe: "x".repeat(5_000) },
		});
		expect(result).toMatchObject({
			token: "[redacted]",
			nested: { password: "[redacted]" },
		});
		expect((result as any).nested.safe.length).toBeLessThan(4_200);
	});

	it("refuses neutral-key narrative content from durable replay projections", () => {
		expect(() =>
			assertSafePersistedValue({
				content: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			}),
		).toThrow(/disallowed data/i);
		expect(() => assertSafePersistedValue({ value: 12_345_678 })).toThrow(/disallowed data/i);
	});

	it("SEC-02 accepts only purpose-typed identifiers and digests as durable strings", () => {
		const digest = `sha256:${"a".repeat(64)}`;
		expect(() =>
			assertSafePersistedValue({
				legacyInvoiceId: "invoice-42",
				invoiceId: actionReplayIdentifier("invoice", "invoice_42"),
				legacyRequestDigest: digest,
				requestDigest: actionReplayDigest("request", digest),
			}),
		).not.toThrow();

		const narrative = "Invoice 43872 for GBP 920.00 from billing@example.test";
		const encodings = [
			Buffer.from(narrative).toString("base64"),
			Buffer.from(narrative).toString("base64url"),
			Buffer.from(narrative).toString("hex"),
			encodeURIComponent(narrative),
		];
		for (const encoded of encodings) {
			expect(() => assertSafePersistedValue({ neutral: { value: encoded } })).toThrow(
				/disallowed data/i,
			);
			expect(() => actionReplayIdentifier("invoice", encoded)).toThrow(/disallowed data/i);
			expect(() => assertSafePersistedValue({ invoiceId: encoded })).toThrow(/disallowed data/i);
		}
		expect(() => assertSafePersistedValue({ nested: { value: "invoice_42" } })).toThrow(
			/disallowed data/i,
		);
		expect(() => actionReplayDigest("request", `sha256:${"g".repeat(64)}`)).toThrow(
			/disallowed data/i,
		);
		expect(() =>
			assertSafePersistedValue({
				value: {
					$agentNative: "opaque-id",
					purpose: "invoice",
					value: "invoice_42",
					narrative,
				},
			}),
		).toThrow(/disallowed data/i);
	});
});
