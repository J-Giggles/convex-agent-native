import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { executeRegisteredAction } from "../action/execute.js";
import { ActionRegistry } from "../action/registry.js";
import { resolveActionScope } from "../contracts/scope.js";
import type {
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { createA2AProtocolAdapter } from "../protocols/a2a.js";
import { ConvexActionCliAdapter } from "../protocols/cli.js";
import { handleMcpRequest } from "../protocols/mcp.js";
import { testSchema as z } from "./standard-schema.js";

class AuditedMemoryPersistence implements InvocationPersistence {
	readonly records = new Map<string, InvocationRecord>();
	readonly audit: Array<{
		invocationId: string;
		actionName: string;
		caller: InvocationRecord["caller"];
		event: "claimed" | "completed" | "failed";
		errorCode?: string;
	}> = [];
	nextId = 1;

	async claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		const key = `${input.scopeKey}\u0000${input.actionName}\u0000${input.idempotencyKey}`;
		const existing = this.records.get(key);
		if (existing) {
			if (
				existing.actorId !== input.actorId ||
				existing.requestFingerprint !== input.requestFingerprint ||
				existing.caller !== input.caller
			) {
				return { outcome: "conflict", invocation: existing };
			}
			return {
				outcome: existing.status === "running" ? "in_flight" : "replay",
				invocation: existing,
			};
		}
		const now = Date.now();
		const invocation: InvocationRecord = {
			id: `inv-${this.nextId++}`,
			...input,
			status: "running",
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(key, invocation);
		this.audit.push({
			invocationId: invocation.id,
			actionName: input.actionName,
			caller: input.caller,
			event: "claimed",
		});
		return { outcome: "claimed", invocation };
	}

	async getInvocation(input: { scopeKey: string; invocationId: string }) {
		return (
			[...this.records.values()].find(
				(record) => record.scopeKey === input.scopeKey && record.id === input.invocationId,
			) ?? null
		);
	}

	async completeInvocation(input: { scopeKey: string; invocationId: string; result: unknown }) {
		const record = await this.getInvocation(input);
		if (!record || record.status !== "running") throw new Error("invalid completion");
		const completed: InvocationRecord = {
			...record,
			status: "completed",
			result: input.result,
			updatedAt: Date.now(),
		};
		this.replace(completed);
		this.audit.push({
			invocationId: record.id,
			actionName: record.actionName,
			caller: record.caller,
			event: "completed",
		});
		return completed;
	}

	async failInvocation(input: {
		scopeKey: string;
		invocationId: string;
		errorCode: string;
		errorMessage: string;
	}) {
		const record = await this.getInvocation(input);
		if (!record || record.status !== "running") throw new Error("invalid failure");
		const failed: InvocationRecord = {
			...record,
			status: "failed",
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			updatedAt: Date.now(),
		};
		this.replace(failed);
		this.audit.push({
			invocationId: record.id,
			actionName: record.actionName,
			caller: record.caller,
			event: "failed",
			errorCode: input.errorCode,
		});
		return failed;
	}

	private replace(updated: InvocationRecord) {
		for (const [key, record] of this.records) {
			if (record.id === updated.id) this.records.set(key, updated);
		}
	}
}

const scope = resolveActionScope({
	scopeKey: "organization:issuer:acme",
	subjectId: "issuer#user-1",
	organizationId: "acme",
});

function registryWith(run: (input: { delta: number }) => { value: number }) {
	return new ActionRegistry().register(
		"increment-widget",
		defineAction({
			description: "Increment a scoped widget",
			schema: z.object({ delta: z.number().int().min(1).max(9) }),
			outputSchema: z.object({ value: z.number().int() }),
			outputErrorStrategy: "strict",
			audit: { enabled: false },
			publicAgent: { expose: true, readOnly: false, requiresAuth: true },
			run,
		}),
		{
			authorizeBeforeClaim: (input, context) =>
				context.orgId === "acme" && (input as { delta: number }).delta <= 2,
			projectReplayResult: ({ value }) => ({ value }),
		},
	);
}

describe("semantically faithful surface conformance", () => {
	it("SUR-I01 shares authorization, idempotency, settlement, and bounded audit semantics", async () => {
		const run = vi.fn(({ delta }: { delta: number }) => ({ value: delta }));
		const registry = registryWith(run);
		const persistence = new AuditedMemoryPersistence();
		const frontendInvoke = (idempotencyKey: string) =>
			executeRegisteredAction(registry, persistence, {
				actionName: "increment-widget",
				input: { delta: 1 },
				caller: "frontend",
				scope,
				idempotencyKey,
			});
		await expect(frontendInvoke("front-1")).resolves.toMatchObject({ replayed: false });
		await expect(frontendInvoke("front-1")).resolves.toMatchObject({ replayed: true });

		const cli = new ConvexActionCliAdapter({
			invoke: (request) =>
				executeRegisteredAction(registry, persistence, {
					...request,
					caller: "cli",
					scope,
				}),
		});
		await expect(
			cli.execute(["increment-widget", '{"delta":1}', "--idempotency-key", "cli-1"]),
		).resolves.toMatchObject({ exitCode: 0 });
		await expect(
			cli.execute(["increment-widget", '{"delta":1}', "--idempotency-key", "cli-1"]),
		).resolves.toMatchObject({ exitCode: 0 });

		const mcpRequest = {
			jsonrpc: "2.0" as const,
			id: "mcp-1",
			method: "tools/call",
			params: { name: "increment-widget", arguments: { delta: 1 } },
		};
		await expect(
			handleMcpRequest({
				registry,
				persistence,
				scope,
				authenticated: true,
				canWrite: true,
				idempotencyKey: "mcp-1",
				request: mcpRequest,
			}),
		).resolves.toMatchObject({ result: { _meta: { replayed: false } } });
		await expect(
			handleMcpRequest({
				registry,
				persistence,
				scope,
				authenticated: true,
				canWrite: true,
				idempotencyKey: "mcp-1",
				request: mcpRequest,
			}),
		).resolves.toMatchObject({ result: { _meta: { replayed: true } } });

		expect(run).toHaveBeenCalledTimes(3);
		expect([...persistence.records.values()].map((record) => record.caller).sort()).toEqual([
			"cli",
			"frontend",
			"mcp",
		]);
		expect([...persistence.records.values()].every((record) => record.status === "completed")).toBe(
			true,
		);
		expect(persistence.audit.map((event) => event.event)).toEqual([
			"claimed",
			"completed",
			"claimed",
			"completed",
			"claimed",
			"completed",
		]);
		expect(JSON.stringify(persistence.audit)).not.toMatch(/delta|idempotency|result|scopeKey/u);
	});

	it("refuses unauthorized or unsupported writes before any durable claim", async () => {
		const run = vi.fn(({ delta }: { delta: number }) => ({ value: delta }));
		const registry = registryWith(run);
		const persistence = new AuditedMemoryPersistence();

		await expect(
			executeRegisteredAction(registry, persistence, {
				actionName: "increment-widget",
				input: { delta: 9 },
				caller: "frontend",
				scope,
				idempotencyKey: "denied-front",
			}),
		).rejects.toMatchObject({ code: "ACTION_NOT_AUTHORIZED" });

		const cli = new ConvexActionCliAdapter({
			invoke: (request) =>
				executeRegisteredAction(registry, persistence, {
					...request,
					caller: "cli",
					scope,
				}),
		});
		await expect(
			cli.execute(["increment-widget", '{"delta":9}', "--idempotency-key", "denied-cli"]),
		).resolves.toMatchObject({ exitCode: 1 });

		await expect(
			handleMcpRequest({
				registry,
				persistence,
				scope,
				authenticated: true,
				canWrite: true,
				idempotencyKey: "denied-mcp",
				request: {
					jsonrpc: "2.0",
					id: "denied",
					method: "tools/call",
					params: { name: "increment-widget", arguments: { delta: 9 } },
				},
			}),
		).resolves.toMatchObject({ error: { code: -32001 } });

		const a2a = createA2AProtocolAdapter({
			name: "Conformance",
			description: "Conformance",
			baseUrl: "https://agent.example.test",
			registry,
			persistence,
		});
		await expect(
			a2a.handle(
				{
					jsonrpc: "2.0",
					id: "a2a-write",
					method: "actions/invoke",
					params: { action: "increment-widget", input: { delta: 1 } },
				},
				{ scope, authenticated: true, audienceVerified: true },
			),
		).resolves.toMatchObject({ error: expect.any(Object) });

		expect(run).not.toHaveBeenCalled();
		expect(persistence.records.size).toBe(0);
		expect(persistence.audit).toEqual([]);
	});
});
