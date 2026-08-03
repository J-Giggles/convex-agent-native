import {
	executeRegisteredAction,
	type ApprovalVerifier,
	type ExecuteRegisteredActionResult,
} from "../action/execute.js";
import type { ActionRegistry } from "../action/registry.js";
import { sanitizeErrorMessage, sanitizePersistedValue } from "../action/sanitize.js";
import { isAgentNativeConvexError, type AgentNativeConvexErrorCode } from "../contracts/error.js";
import type { ResolvedActionScope } from "../contracts/scope.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import { jsonUtf8ByteLength } from "./wire-json.js";

const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export type McpRequestId = string | number | null;

export interface McpToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown> & { type: "object" };
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface McpJsonRpcRequest {
	jsonrpc: "2.0";
	id?: McpRequestId;
	method: string;
	params?: Record<string, unknown>;
}

export interface McpJsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface McpJsonRpcResponse {
	jsonrpc: "2.0";
	id: McpRequestId;
	result?: unknown;
	error?: McpJsonRpcError;
}

export interface McpAccessContext {
	/** Set only after the host verifies the inbound credential. */
	authenticated: boolean;
	/** Separate write grant; authentication alone does not imply write access. */
	canWrite?: boolean;
}

export interface HandleMcpRequestOptions extends Partial<McpAccessContext> {
	registry: ActionRegistry;
	persistence: InvocationPersistence;
	/** Trusted, host-resolved scope. Never derive this from JSON-RPC params. */
	scope: ResolvedActionScope;
	request: McpJsonRpcRequest | unknown;
	idempotencyKey?: string;
	approvedToolCallKey?: string;
	approvalVerifier?: ApprovalVerifier;
	/** Trusted host data made available to the selected action definition only while it runs. */
	executionContext?: unknown;
	serverName?: string;
	serverVersion?: string;
}

function publicConfig(
	registry: ActionRegistry,
	actionName: string,
): ReturnType<ActionRegistry["get"]>["definition"] | null {
	try {
		const { definition } = registry.get(actionName);
		if (
			definition.publicAgent?.expose !== true ||
			definition.agentTool === false ||
			definition.toolCallable === false
		) {
			return null;
		}
		return definition;
	} catch {
		return null;
	}
}

function isVisible(
	definition: ReturnType<ActionRegistry["get"]>["definition"],
	access: McpAccessContext,
): boolean {
	const exposure = definition.publicAgent;
	if (!exposure?.expose) return false;
	if (definition.agentTool === false || definition.toolCallable === false) {
		return false;
	}
	if (exposure.requiresAuth === true && !access.authenticated) return false;
	if (exposure.readOnly !== true) {
		return access.authenticated && access.canWrite === true;
	}
	if (!access.authenticated && exposure.isConsequential === true) return false;
	return true;
}

export function listMcpTools(
	registry: ActionRegistry,
	access: McpAccessContext = { authenticated: false },
): McpToolDescriptor[] {
	return registry
		.list()
		.filter(({ definition }) => isVisible(definition, access))
		.map(({ name, definition }) => {
			const readOnly = definition.publicAgent?.readOnly === true;
			const consequential =
				definition.publicAgent?.isConsequential === true || definition.needsApproval !== undefined;
			return {
				name,
				description: definition.publicAgent?.description ?? definition.tool.description,
				inputSchema: {
					...(definition.tool.parameters ?? { properties: {} }),
					type: "object",
				},
				annotations: {
					readOnlyHint: readOnly,
					destructiveHint: consequential,
					openWorldHint: false,
				},
			};
		});
}

function rpcError(
	id: McpRequestId,
	code: number,
	message: string,
	data?: unknown,
): McpJsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			...(data === undefined ? {} : { data: sanitizePersistedValue(data) }),
		},
	};
}

function requestId(value: unknown): McpRequestId {
	if (!value || typeof value !== "object" || !("id" in value)) return null;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function isRequest(value: unknown): value is McpJsonRpcRequest {
	return Boolean(
		value &&
		typeof value === "object" &&
		(value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
		typeof (value as { method?: unknown }).method === "string",
	);
}

function objectParams(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function actionErrorCode(code: AgentNativeConvexErrorCode): number {
	switch (code) {
		case "ACTION_NOT_FOUND":
		case "ACTION_NOT_EXPOSED":
			return -32003;
		case "APPROVAL_REQUIRED":
		case "APPROVAL_INVALID":
			return -32004;
		case "ACTION_INPUT_INVALID":
		case "ACTION_OUTPUT_INVALID":
			return -32602;
		case "IDEMPOTENCY_KEY_REQUIRED":
		case "IDEMPOTENCY_CONFLICT":
			return -32009;
		case "INVOCATION_IN_FLIGHT":
			return -32010;
		case "INVALID_SCOPE":
		case "ACTION_NOT_AUTHORIZED":
			return -32001;
		default:
			return -32000;
	}
}

function toolResult(execution: ExecuteRegisteredActionResult) {
	const safe = sanitizePersistedValue(execution.result);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(safe) }],
		structuredContent: safe,
		isError: false,
		_meta: {
			...(execution.invocationId === undefined ? {} : { invocationId: execution.invocationId }),
			replayed: execution.replayed,
		},
	};
}

/** Stateless MCP JSON-RPC adapter. HTTP/OAuth/session mounting remains host-owned. */
export async function handleMcpRequest(
	options: HandleMcpRequestOptions,
): Promise<McpJsonRpcResponse | null> {
	const id = requestId(options.request);
	if (!isRequest(options.request)) {
		return rpcError(id, -32600, "Invalid JSON-RPC request");
	}
	const request = options.request;
	const access: McpAccessContext = {
		authenticated: options.authenticated === true,
		canWrite: options.canWrite === true,
	};

	if (request.method === "notifications/initialized") return null;
	if (request.id === undefined) return null;

	if (request.method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: {
					name: options.serverName ?? "agent-native-convex",
					version: options.serverVersion ?? "0.1.0",
				},
			},
		};
	}

	if (request.method === "tools/list") {
		return {
			jsonrpc: "2.0",
			id,
			result: { tools: listMcpTools(options.registry, access) },
		};
	}

	if (request.method !== "tools/call") {
		return rpcError(id, -32601, `Method not found: ${request.method}`);
	}

	const params = objectParams(request.params);
	const name = typeof params?.name === "string" ? params.name.trim() : "";
	const args = params?.arguments ?? {};
	if (!name) return rpcError(id, -32602, "tools/call requires params.name");
	const argumentBytes = jsonUtf8ByteLength(args);
	if (!objectParams(args) || argumentBytes === null || argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
		return rpcError(id, -32602, "Tool arguments must be a JSON object");
	}

	const definition = publicConfig(options.registry, name);
	if (!definition) {
		return rpcError(id, -32003, "Action is not exposed over MCP");
	}
	const exposure = definition.publicAgent!;
	if (exposure.requiresAuth === true && !access.authenticated) {
		return rpcError(id, -32001, "Authentication is required");
	}
	if (exposure.readOnly !== true) {
		if (!access.authenticated) {
			return rpcError(id, -32001, "Authentication is required");
		}
		if (!access.canWrite) {
			return rpcError(id, -32003, "MCP write access is required");
		}
		if (!options.idempotencyKey?.trim()) {
			return rpcError(id, -32009, "Mutating MCP calls require an idempotency key");
		}
		if (exposure.isConsequential === true && !options.approvedToolCallKey?.trim()) {
			return rpcError(id, -32004, "Consequential MCP calls require approval");
		}
		if (exposure.isConsequential === true && !options.approvalVerifier) {
			return rpcError(id, -32004, "Secure MCP approval is not configured");
		}
	}

	try {
		const execution = await executeRegisteredAction(
			options.registry,
			options.persistence,
			{
				actionName: name,
				input: args,
				caller: "mcp",
				scope: options.scope,
				networkProtocol: "mcp",
				networkId: String(id),
				...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
				...(options.approvedToolCallKey === undefined
					? {}
					: { approvedToolCallKey: options.approvedToolCallKey }),
				...(options.executionContext === undefined
					? {}
					: { executionContext: options.executionContext }),
			},
			{
				...(options.approvalVerifier === undefined
					? {}
					: { approvalVerifier: options.approvalVerifier }),
			},
		);
		return { jsonrpc: "2.0", id, result: toolResult(execution) };
	} catch (error) {
		const code = isAgentNativeConvexError(error) ? actionErrorCode(error.code) : -32000;
		return rpcError(
			id,
			code,
			isAgentNativeConvexError(error) ? sanitizeErrorMessage(error) : "MCP action failed",
		);
	}
}
