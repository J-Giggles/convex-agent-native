import { defineAction } from "@agent-native/core/action";
import type { Message, Task, TaskState } from "@agent-native/core/a2a";
import { describe, expect, it, vi } from "vitest";

import { ActionRegistry } from "../action/registry.js";
import { resolveActionScope } from "../contracts/scope.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import {
	createA2AProtocolAdapter,
	isA2ATaskTransitionAllowed,
	type A2ATaskClaimInput,
	type A2ATaskClaimResult,
	type A2ATaskPersistence,
	type A2ATaskTransitionInput,
	type A2ATaskTransitionResult,
} from "./a2a.js";

interface StoredTask {
	task: Task;
	scopeKey: string;
	ownerSubjectId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

class MemoryA2ATasks implements A2ATaskPersistence {
	readonly tasks = new Map<string, StoredTask>();
	readonly keys = new Map<string, string>();

	async claimTask(input: A2ATaskClaimInput): Promise<A2ATaskClaimResult> {
		const key = `${input.scopeKey}:${input.ownerSubjectId}:${input.idempotencyKey}`;
		const currentId = this.keys.get(key);
		if (currentId) {
			const current = this.tasks.get(currentId)!;
			if (current.requestFingerprint !== input.requestFingerprint) {
				return { outcome: "conflict", task: current.task };
			}
			return { outcome: "replay", task: current.task };
		}
		this.keys.set(key, input.task.id);
		this.tasks.set(input.task.id, {
			task: structuredClone(input.task),
			scopeKey: input.scopeKey,
			ownerSubjectId: input.ownerSubjectId,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint: input.requestFingerprint,
		});
		return { outcome: "claimed", task: structuredClone(input.task) };
	}

	async getTask(input: {
		scopeKey: string;
		ownerSubjectId: string;
		taskId: string;
	}): Promise<Task | null> {
		const current = this.tasks.get(input.taskId);
		if (
			!current ||
			current.scopeKey !== input.scopeKey ||
			current.ownerSubjectId !== input.ownerSubjectId
		) {
			return null;
		}
		return structuredClone(current.task);
	}

	async transitionTask(input: A2ATaskTransitionInput): Promise<A2ATaskTransitionResult> {
		const current = this.tasks.get(input.taskId);
		if (
			!current ||
			current.scopeKey !== input.scopeKey ||
			current.ownerSubjectId !== input.ownerSubjectId
		) {
			return { outcome: "not_found" };
		}
		if (current.task.status.state === input.update.status.state) {
			return { outcome: "unchanged", task: structuredClone(current.task) };
		}
		if (
			!input.expectedStates.includes(current.task.status.state) ||
			!isA2ATaskTransitionAllowed(current.task.status.state, input.update.status.state)
		) {
			return { outcome: "invalid_transition", task: structuredClone(current.task) };
		}
		current.task = {
			...current.task,
			status: input.update.status,
			...(input.update.history === undefined ? {} : { history: input.update.history }),
			...(input.update.artifacts === undefined ? {} : { artifacts: input.update.artifacts }),
		};
		return { outcome: "transitioned", task: structuredClone(current.task) };
	}
}

const noInvocationPersistence: InvocationPersistence = {
	getInvocation: async () => null,
	claimInvocation: async () => {
		throw new Error("not used for reads");
	},
	completeInvocation: async () => {
		throw new Error("not used for reads");
	},
	failInvocation: async () => {
		throw new Error("not used for reads");
	},
};

const scope = resolveActionScope({
	scopeKey: "org:acme",
	subjectId: "user:one",
	organizationId: "acme",
});
const otherScope = resolveActionScope({
	scopeKey: "org:acme",
	subjectId: "user:two",
	organizationId: "acme",
});
const authenticated = {
	scope,
	authenticated: true,
	audienceVerified: true,
} as const;

function taskState(task: Task | null | undefined): TaskState | undefined {
	return task?.status.state;
}

describe("A2A v0.3 compatibility adapter", () => {
	function fixture() {
		const taskPersistence = new MemoryA2ATasks();
		const runTask = vi.fn(
			async ({ message }): Promise<{ message: Message }> => ({
				message: {
					role: "agent",
					parts: [
						{
							type: "text",
							text: `done:${message.parts[0]?.type === "text" ? message.parts[0].text : ""}`,
						},
					],
				},
			}),
		);
		const registry = new ActionRegistry().register(
			"get-widget",
			defineAction({
				description: "Get a widget",
				schema: z.object({ id: z.string() }),
				readOnly: true,
				publicAgent: {
					expose: true,
					readOnly: true,
					requiresAuth: true,
				},
				run: ({ id }) => ({ id, value: 2 }),
			}),
		);
		const adapter = createA2AProtocolAdapter({
			name: "Widget agent",
			description: "Reads widgets",
			version: "1.2.3",
			baseUrl: "https://widgets.example.test",
			registry,
			persistence: noInvocationPersistence,
			taskPersistence,
			createId: (() => {
				let next = 1;
				return () => `task-${next++}`;
			})(),
			now: () => new Date("2026-08-02T12:00:00.000Z"),
			runTask,
		});
		return { adapter, runTask, taskPersistence };
	}

	it("A2A-N01 advertises v0.3, invokes a safe read, and completes a durable task", async () => {
		const { adapter } = fixture();
		expect(adapter.agentCard({ authenticated: true })).toMatchObject({
			protocolVersion: "0.3",
			url: "https://widgets.example.test/_agent-native/a2a",
			skills: [{ id: "get-widget", readOnly: true, requiresAuth: true }],
		});

		const direct = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: "direct-1",
				method: "actions/invoke",
				params: { action: "get-widget", input: { id: "w1" } },
			},
			authenticated,
		);
		expect(direct).toMatchObject({
			id: "direct-1",
			result: {
				action: "get-widget",
				status: "completed",
				output: '{"id":"w1","value":2}',
			},
		});

		const workMessage: Message = {
			role: "user",
			parts: [{ type: "text", text: "work" }],
		};
		const submitted = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: "submit-1",
				method: "message/send",
				params: {
					message: workMessage,
					idempotencyKey: "task-once",
				},
			},
			authenticated,
		);
		expect(submitted).toMatchObject({
			id: "submit-1",
			result: { id: "task-2", status: { state: "submitted" } },
		});

		await expect(
			adapter.processTask({ taskId: "task-2", message: workMessage, ...authenticated }),
		).resolves.toMatchObject({ status: { state: "completed" } });

		const completed = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: "get-1",
				method: "tasks/get",
				params: { id: "task-2" },
			},
			authenticated,
		);
		expect(completed).toMatchObject({
			id: "get-1",
			result: {
				status: { state: "completed" },
				history: [
					{ role: "user", metadata: { contentPolicy: "omitted-v1" } },
					{ role: "agent", metadata: { contentPolicy: "omitted-v1" } },
				],
			},
		});
	});

	it("A2A-F01 denies caller mismatch and conflicting idempotent submissions", async () => {
		const { adapter } = fixture();
		const unauthenticated = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: "unauthenticated",
				method: "actions/invoke",
				params: { action: "get-widget", input: { id: "w1" } },
			},
			{ ...authenticated, authenticated: false },
		);
		expect(unauthenticated).toMatchObject({
			id: "unauthenticated",
			error: { code: -32001 },
		});

		const request = {
			jsonrpc: "2.0" as const,
			id: "submit",
			method: "message/send",
			params: {
				message: { role: "user" as const, parts: [{ type: "text" as const, text: "one" }] },
				idempotencyKey: "same-key",
			},
		};
		const first = await adapter.handle(request, authenticated);
		const replay = await adapter.handle({ ...request, id: "replay" }, authenticated);
		expect(replay).toMatchObject({
			id: "replay",
			result: { id: (first.result as Task).id },
		});

		const conflict = await adapter.handle(
			{
				...request,
				id: "conflict",
				params: {
					...request.params,
					message: {
						role: "user",
						parts: [{ type: "text", text: "different work" }],
					},
				},
			},
			authenticated,
		);
		expect(conflict).toMatchObject({
			id: "conflict",
			error: { code: -32009 },
		});

		const denied = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: "cross-caller",
				method: "tasks/get",
				params: { id: (first.result as Task).id },
			},
			{ ...authenticated, scope: otherScope },
		);
		expect(denied).toMatchObject({
			id: "cross-caller",
			error: { code: -32001, message: "Task not found" },
		});

		const unsafeFixture = fixture();
		const unsafeMessage = await unsafeFixture.adapter.handle(
			{
				jsonrpc: "2.0",
				id: "unsafe-message",
				method: "message/send",
				params: {
					message: {
						role: "user",
						parts: [{ type: "text", text: "Authorization: Bearer live-secret-token" }],
					},
					idempotencyKey: "unsafe-message",
				},
			},
			authenticated,
		);
		expect(unsafeMessage).toMatchObject({ id: "unsafe-message", error: { code: -32602 } });
		expect(unsafeFixture.taskPersistence.tasks.size).toBe(0);

		const neutralFixture = fixture();
		const narrative =
			"Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.";
		const neutral = await neutralFixture.adapter.handle(
			{
				jsonrpc: "2.0",
				id: "neutral-message",
				method: "message/send",
				params: {
					message: { role: "user", parts: [{ type: "text", text: narrative }] },
					idempotencyKey: "neutral-message",
				},
			},
			authenticated,
		);
		expect(neutral).toMatchObject({
			id: "neutral-message",
			result: { status: { state: "submitted" } },
		});
		expect(JSON.stringify(neutralFixture.taskPersistence.tasks)).not.toContain(narrative);
		expect(JSON.stringify(neutral.result)).not.toContain(narrative);

		const failing = fixture();
		failing.taskPersistence.getTask = async () => {
			throw new Error("storage offline");
		};
		await expect(
			failing.adapter.handle(
				{
					jsonrpc: "2.0",
					id: "persistence-error",
					method: "tasks/get",
					params: { id: "task-unknown" },
				},
				authenticated,
			),
		).resolves.toMatchObject({
			id: "persistence-error",
			error: { code: -32000, message: "A2A request failed" },
		});
	});

	it("A2A-I01 keeps terminal states monotonic and replays terminal tasks", async () => {
		const { adapter, runTask, taskPersistence } = fixture();
		const onceMessage: Message = {
			role: "user",
			parts: [{ type: "text", text: "once" }],
		};
		const submitted = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: {
					message: onceMessage,
					idempotencyKey: "terminal-once",
				},
			},
			authenticated,
		);
		const taskId = (submitted.result as Task).id;
		const terminals = await Promise.all([
			adapter.processTask({ taskId, message: onceMessage, ...authenticated }),
			adapter.processTask({ taskId, message: onceMessage, ...authenticated }),
		]);
		expect(terminals.map(taskState)).toEqual(["completed", "processing"]);
		expect(runTask).toHaveBeenCalledOnce();

		const canceled = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tasks/cancel",
				params: { id: taskId },
			},
			authenticated,
		);
		expect(canceled).toMatchObject({
			id: 2,
			result: { status: { state: "completed" } },
		});
		expect(
			taskState(
				await taskPersistence.getTask({
					scopeKey: scope.scopeKey,
					ownerSubjectId: scope.subjectId,
					taskId,
				}),
			),
		).toBe("completed");

		expect(isA2ATaskTransitionAllowed("completed", "working")).toBe(false);
		expect(isA2ATaskTransitionAllowed("failed", "completed")).toBe(false);
		expect(isA2ATaskTransitionAllowed("submitted", "working")).toBe(true);
	});
});
