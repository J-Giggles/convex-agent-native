import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { ActionRegistry } from "../action/registry.js";
import { resolveActionScope } from "../contracts/scope.js";
import type {
	ClaimInvocationInput,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import { handleMcpRequest, listMcpTools } from "./mcp.js";

const unusedPersistence: InvocationPersistence = {
	getInvocation: async () => null,
	claimInvocation: async () => {
		throw new Error("unexpected persistence claim");
	},
	completeInvocation: async () => {
		throw new Error("unexpected persistence completion");
	},
	failInvocation: async () => {
		throw new Error("unexpected persistence failure");
	},
};

class MemoryInvocations implements InvocationPersistence {
	record: InvocationRecord | null = null;

	async getInvocation(): Promise<InvocationRecord | null> {
		return this.record;
	}

	async claimInvocation(input: ClaimInvocationInput) {
		const now = Date.now();
		this.record = {
			id: "invocation-1",
			...input,
			status: "running",
			createdAt: now,
			updatedAt: now,
		};
		return { outcome: "claimed" as const, invocation: this.record };
	}

	async completeInvocation(input: {
		scopeKey: string;
		invocationId: string;
		result: unknown;
	}): Promise<InvocationRecord> {
		if (!this.record) throw new Error("missing invocation");
		this.record = {
			...this.record,
			status: "completed",
			result: input.result,
			updatedAt: Date.now(),
		};
		return this.record;
	}

	async failInvocation(input: {
		scopeKey: string;
		invocationId: string;
		errorCode: string;
		errorMessage: string;
	}): Promise<InvocationRecord> {
		if (!this.record) throw new Error("missing invocation");
		this.record = {
			...this.record,
			status: "failed",
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			updatedAt: Date.now(),
		};
		return this.record;
	}
}

const scope = resolveActionScope({
	scopeKey: "org:acme",
	subjectId: "user:one",
	organizationId: "acme",
});

describe("compatibility MCP adapter", () => {
	const publicRead = vi.fn(({ id }: { id: string }) => ({ id, value: 4 }));
	const registry = new ActionRegistry()
		.register(
			"get-widget",
			defineAction({
				description: "Get a widget",
				schema: z.object({ id: z.string() }),
				readOnly: true,
				publicAgent: { expose: true, readOnly: true },
				run: publicRead,
			}),
		)
		.register(
			"private-widget",
			defineAction({
				description: "Private widget",
				schema: z.object({}),
				readOnly: true,
				run: () => ({ ok: true }),
			}),
		)
		.register(
			"delete-widget",
			defineAction({
				description: "Delete a widget",
				schema: z.object({ id: z.string() }),
				publicAgent: {
					expose: true,
					readOnly: false,
					requiresAuth: true,
					isConsequential: true,
				},
				needsApproval: true,
				audit: { enabled: false },
				run: () => ({ ok: true }),
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);

	it("MCP-N01 performs the handshake and preserves a tools/call request id", async () => {
		await expect(
			handleMcpRequest({
				registry,
				persistence: unusedPersistence,
				scope,
				request: {
					jsonrpc: "2.0",
					id: "init-1",
					method: "initialize",
					params: { protocolVersion: "2025-03-26" },
				},
			}),
		).resolves.toMatchObject({
			id: "init-1",
			result: { capabilities: { tools: {} } },
		});

		expect(listMcpTools(registry, { authenticated: false })).toEqual([
			expect.objectContaining({
				name: "get-widget",
				annotations: expect.objectContaining({ readOnlyHint: true }),
			}),
		]);

		const response = await handleMcpRequest({
			registry,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: "call-7",
				method: "tools/call",
				params: { name: "get-widget", arguments: { id: "widget-1" } },
			},
		});

		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: "call-7",
			result: {
				content: [{ type: "text", text: '{"id":"widget-1","value":4}' }],
				structuredContent: { id: "widget-1", value: 4 },
				isError: false,
			},
		});
		expect(publicRead).toHaveBeenCalledWith(
			{ id: "widget-1" },
			expect.objectContaining({ caller: "mcp", orgId: "acme" }),
		);

		const approvalVerifier = {
			verifyAndConsume: vi.fn(async () => true),
		};
		const writeResponse = await handleMcpRequest({
			registry,
			persistence: new MemoryInvocations(),
			scope,
			authenticated: true,
			canWrite: true,
			idempotencyKey: "delete-once",
			approvedToolCallKey: "approval-grant",
			approvalVerifier,
			request: {
				jsonrpc: "2.0",
				id: "write-1",
				method: "tools/call",
				params: { name: "delete-widget", arguments: { id: "widget-1" } },
			},
		});
		expect(writeResponse).toMatchObject({
			id: "write-1",
			result: { structuredContent: { ok: true }, isError: false },
		});
		expect(approvalVerifier.verifyAndConsume).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalGrant: "approval-grant",
				actionName: "delete-widget",
				actorId: "user:one",
			}),
		);
	});

	it("MCP-F01 hides private tools and refuses unauthenticated consequential writes", async () => {
		expect(listMcpTools(registry, { authenticated: false })).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "private-widget" }),
				expect.objectContaining({ name: "delete-widget" }),
			]),
		);

		const privateResponse = await handleMcpRequest({
			registry,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: 11,
				method: "tools/call",
				params: { name: "private-widget", arguments: {} },
			},
		});
		expect(privateResponse).toMatchObject({
			id: 11,
			error: { code: -32003, message: "Action is not exposed over MCP" },
		});

		const writeResponse = await handleMcpRequest({
			registry,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: 12,
				method: "tools/call",
				params: { name: "delete-widget", arguments: { id: "widget-1" } },
			},
			idempotencyKey: "delete-once",
			approvedToolCallKey: "approval-secret",
		});
		expect(writeResponse).toMatchObject({
			id: 12,
			error: { code: -32001, message: "Authentication is required" },
		});

		const oversized = await handleMcpRequest({
			registry,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: 13,
				method: "tools/call",
				params: { name: "get-widget", arguments: { id: "x".repeat(70_000) } },
			},
		});
		expect(oversized).toMatchObject({ id: 13, error: { code: -32602 } });
	});

	it("MCP-I01 preserves error ids and redacts credentials", async () => {
		const invalid = await handleMcpRequest({
			registry,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: "same-id",
				method: "tools/call",
			},
		});
		expect(invalid).toMatchObject({
			id: "same-id",
			error: { code: -32602 },
		});

		const throwsSecret = new ActionRegistry().register(
			"secret-failure",
			defineAction({
				description: "Fails safely",
				schema: z.object({}),
				readOnly: true,
				publicAgent: { expose: true, readOnly: true },
				run: () => {
					throw new Error("Authorization: Bearer top-secret-token");
				},
			}),
		);
		const failed = await handleMcpRequest({
			registry: throwsSecret,
			persistence: unusedPersistence,
			scope,
			request: {
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: { name: "secret-failure", arguments: {} },
			},
		});
		expect(JSON.stringify(failed)).not.toContain("top-secret-token");
		expect(failed).toMatchObject({ id: 99, error: { code: -32000 } });
	});
});
