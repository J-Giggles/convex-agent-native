import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { resolveActionScope } from "../contracts/scope.js";
import type {
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import { ActionRegistry } from "../action/registry.js";
import { createRegisteredActionTool } from "./registered-action-tool.js";

class MemoryInvocations implements InvocationPersistence {
	record?: InvocationRecord;

	async claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		this.record = {
			id: "inv_tool_1",
			...input,
			status: "running",
			createdAt: 1,
			updatedAt: 1,
		};
		return { outcome: "claimed", invocation: this.record };
	}

	async getInvocation(): Promise<InvocationRecord | null> {
		return this.record ?? null;
	}

	async completeInvocation(input: {
		scopeKey: string;
		invocationId: string;
		result: unknown;
	}): Promise<InvocationRecord> {
		if (!this.record) throw new Error("missing invocation");
		this.record = { ...this.record, status: "completed", result: input.result };
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
		};
		return this.record;
	}
}

describe("registered action agent tool", () => {
	it("CHT-N-001 executes the exact registered definition through the durable dispatcher", async () => {
		const schema = z.object({ title: z.string() });
		const run = vi.fn((input: { title: string }, context) => ({
			id: "task_1",
			title: input.title,
			caller: context?.caller,
		}));
		const registry = new ActionRegistry().register(
			"create-task",
			defineAction({
				description: "Create a task",
				schema,
				audit: { enabled: false },
				run,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => ({ taskId: result.id }),
			},
		);
		const persistence = new MemoryInvocations();
		const prepareExecution = vi.fn(() => ({
			persistence,
			scope: resolveActionScope({ scopeKey: "demo:one", subjectId: "anon:one" }),
		}));
		const tool = createRegisteredActionTool({
			registry,
			actionName: "create-task",
			ctx: {} as never,
			prepareExecution,
		});

		expect(tool.description).toBe("Create a task");
		expect(tool.inputSchema).toBe(schema);
		await expect(
			tool.execute?.({ title: "Ship demo" }, { toolCallId: "call_123", messages: [] }),
		).resolves.toEqual({ id: "task_1", title: "Ship demo", caller: "tool" });
		expect(prepareExecution).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
		expect(persistence.record).toMatchObject({
			actionName: "create-task",
			caller: "tool",
			idempotencyKey: "call_123",
			status: "completed",
		});
	});

	it("refuses an exhausted host quota before the action or durable claim", async () => {
		const run = vi.fn(() => ({ taskId: "task_1" }));
		const registry = new ActionRegistry().register(
			"create-task",
			defineAction({
				description: "Create a task",
				schema: z.object({ title: z.string() }),
				audit: { enabled: false },
				run,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);
		const persistence = new MemoryInvocations();
		const tool = createRegisteredActionTool({
			registry,
			actionName: "create-task",
			ctx: {} as never,
			prepareExecution: async () => {
				throw new Error("DEMO_QUOTA_EXHAUSTED");
			},
		});

		await expect(
			tool.execute?.({ title: "Over quota" }, { toolCallId: "call_456", messages: [] }),
		).rejects.toThrow("DEMO_QUOTA_EXHAUSTED");
		expect(run).not.toHaveBeenCalled();
		expect(persistence.record).toBeUndefined();
	});

	it("routes approval grants through the dispatcher verifier", async () => {
		const run = vi.fn(() => ({ taskId: "task_approved" }));
		const registry = new ActionRegistry().register(
			"delete-task",
			defineAction({
				description: "Delete a task",
				schema: z.object({ taskId: z.string() }),
				needsApproval: true,
				audit: { enabled: false },
				run,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);
		const persistence = new MemoryInvocations();
		const verifyAndConsume = vi.fn(() => Promise.resolve(true));
		const withoutGrant = createRegisteredActionTool({
			registry,
			actionName: "delete-task",
			ctx: {} as never,
			prepareExecution: () => ({
				persistence,
				scope: resolveActionScope({ scopeKey: "demo:one", subjectId: "anon:one" }),
			}),
		});

		expect(
			await (withoutGrant.needsApproval as (
				input: unknown,
				options: { toolCallId: string; messages: [] },
			) => boolean)({ taskId: "task_approved" }, { toolCallId: "call_delete", messages: [] }),
		).toBe(true);
		await expect(
			withoutGrant.execute?.(
				{ taskId: "task_approved" },
				{ toolCallId: "call_delete", messages: [] },
			),
		).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
		expect(persistence.record).toBeUndefined();

		const withGrant = createRegisteredActionTool({
			registry,
			actionName: "delete-task",
			ctx: {} as never,
			prepareExecution: () => ({
				persistence,
				scope: resolveActionScope({ scopeKey: "demo:one", subjectId: "anon:one" }),
				approvedToolCallKey: "approval_delete",
				security: { approvalVerifier: { verifyAndConsume } },
			}),
		});
		await expect(
			withGrant.execute?.(
				{ taskId: "task_approved" },
				{ toolCallId: "call_delete", messages: [] },
			),
		).resolves.toEqual({ taskId: "task_approved" });
		expect(verifyAndConsume).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
	});

	it("optionally exposes the dispatcher receipt to a host that needs invocation metadata", async () => {
		const registry = new ActionRegistry().register(
			"complete-task",
			defineAction({
				description: "Complete a task",
				schema: z.object({ taskId: z.string() }),
				audit: { enabled: false },
				run: ({ taskId }) => ({ taskId, completed: true }),
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: (result) => result,
			},
		);
		const persistence = new MemoryInvocations();
		const tool = createRegisteredActionTool({
			registry,
			actionName: "complete-task",
			ctx: {} as never,
			returnInvocationEnvelope: true,
			prepareExecution: () => ({
				persistence,
				scope: resolveActionScope({ scopeKey: "demo:one", subjectId: "anon:one" }),
			}),
		});

		await expect(
			tool.execute?.(
				{ taskId: "task_receipt" },
				{ toolCallId: "call_receipt", messages: [] },
			),
		).resolves.toEqual({
			invocationId: "inv_tool_1",
			replayed: false,
			result: { taskId: "task_receipt", completed: true },
		});
	});
});
