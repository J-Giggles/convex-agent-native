import {
	type A2AHandlerResult,
	type A2AReadOnlyActionInvocation,
	type A2AReadOnlyActionResult,
	type AgentCard,
	type AgentSkill,
	type Artifact,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type Message,
	type Part,
	type Task,
	type TaskState,
	type TaskStatus,
} from "@agent-native/core/a2a";

import { executeRegisteredAction } from "../action/execute.js";
import { isExposedToExternalAgents } from "../action/exposure.js";
import { normalizeToolParameters } from "../action/tool-schema.js";
import type { ActionRegistry } from "../action/registry.js";
import { sanitizeErrorMessage, sanitizePersistedValue } from "../action/sanitize.js";
import { isResolvedActionScope, type ResolvedActionScope } from "../contracts/scope.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import { generateAgentCard } from "../internal/agent-card.js";
import { jsonUtf8ByteLength, stableJson } from "./wire-json.js";

const MAX_ACTION_NAME_CHARS = 96;
const MAX_ACTION_INPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_TEXT_CHARS = 8 * 1024;
const MAX_MESSAGE_PARTS = 32;
const MAX_CONTEXT_ID_CHARS = 256;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;

const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "canceled"]);

export interface A2ATaskClaimInput {
	scopeKey: string;
	ownerSubjectId: string;
	idempotencyKey: string;
	/** SHA-256 of the bounded, redacted task request; never the raw message. */
	requestFingerprint: string;
	task: Task;
}

export type A2ATaskClaimResult =
	| { outcome: "claimed"; task: Task }
	| { outcome: "replay"; task: Task }
	| { outcome: "conflict"; task: Task };

export interface A2ATaskTransitionInput {
	scopeKey: string;
	ownerSubjectId: string;
	taskId: string;
	expectedStates: readonly TaskState[];
	update: {
		status: TaskStatus;
		history?: Message[];
		artifacts?: Artifact[];
	};
}

export type A2ATaskTransitionResult =
	| { outcome: "transitioned"; task: Task }
	| { outcome: "unchanged"; task: Task }
	| { outcome: "invalid_transition"; task: Task }
	| { outcome: "not_found" };

/** Atomic, caller-scoped durable task operations supplied by the host. */
export interface A2ATaskPersistence {
	claimTask(input: A2ATaskClaimInput): Promise<A2ATaskClaimResult>;
	getTask(input: {
		scopeKey: string;
		ownerSubjectId: string;
		taskId: string;
	}): Promise<Task | null>;
	transitionTask(input: A2ATaskTransitionInput): Promise<A2ATaskTransitionResult>;
}

export interface A2AAuthenticatedContext {
	/** Trusted scope resolved from the verified bearer identity by the host. */
	scope: ResolvedActionScope;
	authenticated: boolean;
	audienceVerified: boolean;
}

export interface A2ATaskRunInput {
	taskId: string;
	message: Message;
	scope: ResolvedActionScope;
}

export interface AgentNativeA2AAdapterOptions {
	name: string;
	description: string;
	version?: string;
	baseUrl: string;
	registry: ActionRegistry;
	persistence: InvocationPersistence;
	taskPersistence?: A2ATaskPersistence;
	runTask?: (input: A2ATaskRunInput) => Promise<A2AHandlerResult>;
	requireAuthentication?: boolean;
	createId?: () => string;
	now?: () => Date;
}

export interface AgentNativeA2AAdapter {
	agentCard(options?: { authenticated?: boolean }): AgentCard;
	executeReadOnlyAction(
		invocation: A2AReadOnlyActionInvocation,
		scope: ResolvedActionScope,
	): Promise<A2AReadOnlyActionResult>;
	handle(
		request: JsonRpcRequest | unknown,
		context: A2AAuthenticatedContext,
	): Promise<JsonRpcResponse>;
	processTask(
		input: { taskId: string; message: Message | unknown } & A2AAuthenticatedContext,
	): Promise<Task>;
}

export function isA2ATerminalTaskState(state: TaskState): boolean {
	return TERMINAL_TASK_STATES.has(state);
}

export function isA2ATaskTransitionAllowed(from: TaskState, to: TaskState): boolean {
	if (from === to) return true;
	switch (from) {
		case "submitted":
			return to === "working" || to === "failed" || to === "canceled";
		case "working":
			return (
				to === "processing" ||
				to === "completed" ||
				to === "failed" ||
				to === "canceled" ||
				to === "input-required"
			);
		case "processing":
			return to === "completed" || to === "failed" || to === "canceled" || to === "input-required";
		case "input-required":
			return to === "working" || to === "failed" || to === "canceled";
		case "completed":
		case "failed":
		case "canceled":
			return false;
	}
}

function boundText(text: string): string {
	const redacted = String(sanitizePersistedValue(text));
	return redacted.length <= MAX_MESSAGE_TEXT_CHARS
		? redacted
		: `${redacted.slice(0, MAX_MESSAGE_TEXT_CHARS)}…[truncated]`;
}

function sanitizePart(part: Part): Part {
	switch (part.type) {
		case "text":
			return { type: "text", text: boundText(part.text) };
		case "data":
			return {
				type: "data",
				data: sanitizePersistedValue(part.data) as Record<string, unknown>,
			};
		case "file":
			return {
				type: "file",
				file: {
					...(part.file.name === undefined ? {} : { name: boundText(part.file.name) }),
					...(part.file.mimeType === undefined ? {} : { mimeType: boundText(part.file.mimeType) }),
					...(part.file.uri === undefined ? {} : { uri: boundText(part.file.uri) }),
					// File bytes are deliberately not copied into compatibility state.
				},
			};
	}
}

function sanitizeMessage(message: Message): Message {
	return {
		role: message.role,
		parts: message.parts.slice(0, MAX_MESSAGE_PARTS).map(sanitizePart),
		...(message.metadata === undefined
			? {}
			: {
					metadata: sanitizePersistedValue(message.metadata) as Record<string, unknown>,
				}),
	};
}

/**
 * Durable task history deliberately records structure, never message content.
 * The authenticated worker must resupply the request and prove its digest when
 * claiming processing authority.
 */
function durableMessageEnvelope(message: Message): Message {
	return {
		role: message.role,
		parts: message.parts.map((part) => ({
			type: "data" as const,
			data: { contentOmitted: true, originalType: part.type },
		})),
		metadata: { contentPolicy: "omitted-v1" },
	};
}

function validateMessage(value: unknown): Message | null {
	if (!value || typeof value !== "object") return null;
	const message = value as Partial<Message>;
	if (
		(message.role !== "user" && message.role !== "agent") ||
		!Array.isArray(message.parts) ||
		message.parts.length === 0 ||
		message.parts.length > MAX_MESSAGE_PARTS
	) {
		return null;
	}
	for (const part of message.parts) {
		if (!part || typeof part !== "object" || !("type" in part)) return null;
		if (part.type === "text" && typeof part.text === "string") continue;
		if (
			part.type === "data" &&
			part.data &&
			typeof part.data === "object" &&
			!Array.isArray(part.data)
		) {
			continue;
		}
		if (part.type === "file" && part.file && typeof part.file === "object") {
			continue;
		}
		return null;
	}
	const messageBytes = jsonUtf8ByteLength(message);
	if (messageBytes === null || messageBytes > MAX_ACTION_INPUT_BYTES) return null;
	const sanitized = sanitizeMessage(message as Message);
	return stableJson(sanitized) === stableJson(message) ? sanitized : null;
}

async function fingerprint(value: unknown): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Secure task request fingerprinting is unavailable");
	}
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(stableJson(value)),
	);
	return `sha256:${[...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number, value: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result: value };
}

function requestId(value: unknown): string | number | null {
	if (!value || typeof value !== "object") return null;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" || typeof id === "number" ? id : null;
}

function isRpcRequest(value: unknown): value is JsonRpcRequest {
	return Boolean(
		value &&
		typeof value === "object" &&
		(value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
		(typeof (value as { id?: unknown }).id === "string" ||
			typeof (value as { id?: unknown }).id === "number") &&
		typeof (value as { method?: unknown }).method === "string",
	);
}

function trustedContext(context: A2AAuthenticatedContext): boolean {
	return (
		context.authenticated === true &&
		context.audienceVerified === true &&
		isResolvedActionScope(context.scope)
	);
}

function taskInput(
	context: A2AAuthenticatedContext,
	taskId: string,
): { scopeKey: string; ownerSubjectId: string; taskId: string } {
	return {
		scopeKey: context.scope.scopeKey,
		ownerSubjectId: context.scope.subjectId,
		taskId,
	};
}

function skillsForRegistry(registry: ActionRegistry, authenticated: boolean): AgentSkill[] {
	return registry
		.list()
		.filter(({ definition }) => {
			const exposure = definition.publicAgent;
			if (!exposure || !isExposedToExternalAgents(definition) || exposure.readOnly !== true) {
				return false;
			}
			return authenticated || (exposure.requiresAuth !== true && exposure.isConsequential !== true);
		})
		.map(({ name, definition }) => ({
			id: name,
			name: definition.publicAgent?.title ?? name,
			description: definition.publicAgent?.description ?? definition.tool.description,
			tags: ["agent-native", "action", "read-only"],
			public: definition.publicAgent?.requiresAuth !== true,
			readOnly: true,
			requiresAuth: definition.publicAgent?.requiresAuth === true,
			isConsequential: definition.publicAgent?.isConsequential === true,
			...(definition.publicAgent === undefined ? {} : { publicAgent: definition.publicAgent }),
			inputSchema: normalizeToolParameters(definition.tool.parameters),
		}));
}

function defaultId(): string {
	if (!globalThis.crypto?.randomUUID) {
		throw new Error("Secure task id generation is unavailable");
	}
	return globalThis.crypto.randomUUID();
}

function taskStatus(state: TaskState, now: () => Date, message?: Message): TaskStatus {
	return {
		state,
		timestamp: now().toISOString(),
		...(message === undefined ? {} : { message: sanitizeMessage(message) }),
	};
}

function transitionTask(
	persistence: A2ATaskPersistence,
	context: A2AAuthenticatedContext,
	taskId: string,
	expectedStates: readonly TaskState[],
	update: A2ATaskTransitionInput["update"],
): Promise<A2ATaskTransitionResult> {
	for (const state of expectedStates) {
		if (!isA2ATaskTransitionAllowed(state, update.status.state)) {
			throw new Error(`Invalid A2A task transition: ${state} -> ${update.status.state}`);
		}
	}
	return persistence.transitionTask({
		...taskInput(context, taskId),
		expectedStates,
		update,
	});
}

function terminalOrThrow(result: A2ATaskTransitionResult): Task {
	if (result.outcome === "transitioned" || result.outcome === "unchanged") {
		return result.task;
	}
	if (result.outcome === "invalid_transition" && isA2ATerminalTaskState(result.task.status.state)) {
		return result.task;
	}
	throw new Error(
		result.outcome === "not_found" ? "A2A task not found" : "A2A task transition was rejected",
	);
}

export function createA2AProtocolAdapter(
	options: AgentNativeA2AAdapterOptions,
): AgentNativeA2AAdapter {
	const now = options.now ?? (() => new Date());
	const createId = options.createId ?? defaultId;

	async function executeReadOnlyAction(
		invocation: A2AReadOnlyActionInvocation,
		scope: ResolvedActionScope,
	): Promise<A2AReadOnlyActionResult> {
		try {
			const executed = await executeRegisteredAction(options.registry, options.persistence, {
				actionName: invocation.action,
				input: invocation.input,
				caller: "a2a",
				scope,
				networkProtocol: "a2a",
				networkId: invocation.invocationId,
			});
			return {
				action: invocation.action,
				status: "completed",
				output: JSON.stringify(sanitizePersistedValue(executed.result)),
			};
		} catch (error) {
			return {
				action: invocation.action,
				status: "failed",
				output: "A2A action failed",
			};
		}
	}

	async function handle(
		request: JsonRpcRequest | unknown,
		context: A2AAuthenticatedContext,
	): Promise<JsonRpcResponse> {
		const id = requestId(request);
		if (!isRpcRequest(request)) {
			return rpcError(id, -32600, "Invalid JSON-RPC request");
		}
		const params = request.params ?? {};
		if (!trustedContext(context)) {
			return rpcError(request.id, -32001, "A verified caller identity is required");
		}

		if (request.method === "actions/invoke") {
			const action = typeof params.action === "string" ? params.action.trim() : "";
			const input = params.input ?? {};
			if (!action || action.length > MAX_ACTION_NAME_CHARS) {
				return rpcError(request.id, -32602, "Invalid params: action required");
			}
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				return rpcError(request.id, -32602, "Invalid params: input must be an object");
			}
			const inputBytes = jsonUtf8ByteLength(input);
			if (inputBytes === null) {
				return rpcError(request.id, -32602, "Invalid params: input must be JSON-safe");
			}
			if (inputBytes > MAX_ACTION_INPUT_BYTES) {
				return rpcError(request.id, -32602, "Invalid params: input is too large");
			}
			const direct = await executeReadOnlyAction(
				{
					action,
					input: input as Record<string, unknown>,
					invocationId: createId(),
				},
				context.scope,
			);
			if (direct.status === "failed") {
				return rpcError(request.id, -32000, "Direct action invocation failed");
			}
			return rpcResult(request.id, direct);
		}

		if (request.method === "message/send") {
			if (!options.taskPersistence) {
				return rpcError(request.id, -32601, "Durable A2A tasks are not configured");
			}
			const message = validateMessage(params.message);
			if (!message || message.role !== "user") {
				return rpcError(request.id, -32602, "Invalid params: user message with parts required");
			}
			const idempotencyKey =
				typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : "";
			if (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
				return rpcError(request.id, -32602, "Invalid params: bounded idempotencyKey required");
			}
			const contextId = typeof params.contextId === "string" ? params.contextId.trim() : "";
			if (contextId.length > MAX_CONTEXT_ID_CHARS) {
				return rpcError(request.id, -32602, "Invalid params: contextId is too long");
			}
			const requestFingerprint = await fingerprint({ message, contextId });
			const task: Task = {
				id: createId(),
				...(contextId ? { contextId } : {}),
				status: taskStatus("submitted", now),
				history: [durableMessageEnvelope(message)],
				metadata: { requestFingerprint, contentPolicy: "omitted-v1" },
			};
			let claim: A2ATaskClaimResult;
			try {
				claim = await options.taskPersistence.claimTask({
					scopeKey: context.scope.scopeKey,
					ownerSubjectId: context.scope.subjectId,
					idempotencyKey,
					requestFingerprint,
					task,
				});
			} catch {
				return rpcError(request.id, -32000, "A2A task persistence failed");
			}
			if (claim.outcome === "conflict") {
				return rpcError(
					request.id,
					-32009,
					"Idempotency key was already used for a different request",
				);
			}
			return rpcResult(request.id, claim.task);
		}

		if (request.method === "tasks/get" || request.method === "tasks/cancel") {
			if (!options.taskPersistence) {
				return rpcError(request.id, -32601, "Durable A2A tasks are not configured");
			}
			const taskId = typeof params.id === "string" ? params.id.trim() : "";
			if (!taskId) return rpcError(request.id, -32602, "Invalid params: id required");
			const task = await options.taskPersistence.getTask(taskInput(context, taskId));
			if (!task) return rpcError(request.id, -32001, "Task not found");
			if (request.method === "tasks/get" || isA2ATerminalTaskState(task.status.state)) {
				return rpcResult(request.id, task);
			}
			const canceled = await transitionTask(
				options.taskPersistence,
				context,
				taskId,
				["submitted", "working", "processing", "input-required"],
				{ status: taskStatus("canceled", now) },
			);
			return rpcResult(request.id, terminalOrThrow(canceled));
		}

		return rpcError(request.id, -32601, `Method not found: ${request.method}`);
	}

	async function processTask(
		input: { taskId: string; message: Message | unknown } & A2AAuthenticatedContext,
	): Promise<Task> {
		if (!trustedContext(input)) throw new Error("Verified A2A task scope required");
		if (!options.taskPersistence) throw new Error("Durable A2A tasks are not configured");
		const current = await options.taskPersistence.getTask(taskInput(input, input.taskId));
		if (!current) throw new Error("A2A task not found");
		if (isA2ATerminalTaskState(current.status.state)) return current;

		let active = current;
		let ownsProcessing = false;
		if (active.status.state === "submitted") {
			active = terminalOrThrow(
				await transitionTask(options.taskPersistence, input, input.taskId, ["submitted"], {
					status: taskStatus("working", now),
				}),
			);
		}
		if (active.status.state === "working") {
			const claimed = await transitionTask(
				options.taskPersistence,
				input,
				input.taskId,
				["working"],
				{ status: taskStatus("processing", now) },
			);
			active = terminalOrThrow(claimed);
			ownsProcessing = claimed.outcome === "transitioned";
		}
		if (active.status.state !== "processing" || !ownsProcessing) return active;

		const message = validateMessage(input.message);
		const expectedFingerprint = active.metadata?.requestFingerprint;
		const actualFingerprint = message
			? await fingerprint({ message, contextId: active.contextId ?? "" })
			: null;
		if (
			!message ||
			typeof expectedFingerprint !== "string" ||
			expectedFingerprint !== actualFingerprint ||
			!options.runTask
		) {
			const unavailable = durableMessageEnvelope({
				role: "agent",
				parts: [{ type: "text", text: "Task processor unavailable" }],
			});
			return terminalOrThrow(
				await transitionTask(options.taskPersistence, input, input.taskId, ["processing"], {
					status: taskStatus("failed", now, unavailable),
					history: [...(active.history ?? []), unavailable],
				}),
			);
		}

		try {
			const handled = await options.runTask({
				taskId: input.taskId,
				message,
				scope: input.scope,
			});
			const response = durableMessageEnvelope(sanitizeMessage(handled.message));
			const nextState = handled.taskState ?? "completed";
			return terminalOrThrow(
				await transitionTask(options.taskPersistence, input, input.taskId, ["processing"], {
					status: taskStatus(nextState, now, response),
					history: [...(active.history ?? []), response],
				}),
			);
		} catch {
			const failure = durableMessageEnvelope({
				role: "agent",
				parts: [{ type: "text", text: "A2A task failed" }],
			});
			return terminalOrThrow(
				await transitionTask(options.taskPersistence, input, input.taskId, ["processing"], {
					status: taskStatus("failed", now, failure),
					history: [...(active.history ?? []), failure],
				}),
			);
		}
	}

	return {
		agentCard({ authenticated = false } = {}) {
			const card = generateAgentCard(
				{
					name: options.name,
					description: options.description,
					...(options.version === undefined ? {} : { version: options.version }),
					skills: skillsForRegistry(options.registry, authenticated),
					publicSkillsOnly: !authenticated,
				},
				options.baseUrl,
			);
			if (options.requireAuthentication !== false) {
				card.securitySchemes = {
					...(card.securitySchemes ?? {}),
					jwtBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
				};
				card.security = [{ jwtBearer: [] }];
			}
			return card;
		},
		executeReadOnlyAction,
		async handle(request, context) {
			try {
				return await handle(request, context);
			} catch {
				return rpcError(requestId(request), -32000, "A2A request failed");
			}
		},
		processTask,
	};
}

/** v0.1 source-compatible name retained for existing consumers. */
export const createA2AAdapter = createA2AProtocolAdapter;
