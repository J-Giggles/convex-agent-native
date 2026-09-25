import type { ActionCaller, ActionDefinition, ActionRunContext } from "@agent-native/core/action";
import type { CliAdapter, CliResult } from "@agent-native/core/adapters/cli";
import type {
	AgentCard,
	JsonRpcRequest,
	JsonRpcResponse,
	Task,
	TaskState,
} from "@agent-native/core/a2a";
import type {
	AgentNativeExtensionDefinition,
	AgentNativeExtensionManifest,
	AgentNativeExtensionStorage,
} from "@agent-native/core/client/extensions";
import type { MCPCallerIdentity, MCPRequestMeta } from "@agent-native/core/mcp";
import type { AgentComponent, StreamArgs, Thread } from "@convex-dev/agent";
import type { ThreadMessagesQuery } from "@convex-dev/agent/react";

/**
 * Compile-only snapshot of the reviewed upstream public seams. A dependency
 * update that removes or renames one of these types must fail package typecheck
 * before the compatibility version is changed.
 */
export interface UpstreamPublicTypeSnapshot {
	actionDefinition: ActionDefinition<unknown, unknown>;
	actionCaller: ActionCaller;
	actionRunContext: ActionRunContext;
	cliAdapter: CliAdapter;
	cliResult: CliResult;
	a2aCard: AgentCard;
	a2aRequest: JsonRpcRequest;
	a2aResponse: JsonRpcResponse;
	a2aTask: Task;
	a2aTaskState: TaskState;
	extensionDefinition: AgentNativeExtensionDefinition;
	extensionManifest: AgentNativeExtensionManifest;
	extensionStorage: AgentNativeExtensionStorage;
	mcpCaller: MCPCallerIdentity;
	mcpMeta: MCPRequestMeta;
	convexAgentComponent: AgentComponent;
	convexAgentStreamArgs: StreamArgs;
	convexAgentThread: Thread<any>;
	convexAgentThreadMessagesQuery: ThreadMessagesQuery;
}

export const PUBLIC_API_GROUP_SNAPSHOT = Object.freeze({
	action: Object.freeze([
		"ActionRegistry",
		"defineConvexAction",
		"deriveApprovalKey",
		"executeRegisteredAction",
		"isExposedToExternalAgents",
		"isExposedToInAppAgent",
		"normalizeToolParameters",
		"readActionExecutionContext",
	]),
	agent: Object.freeze(["createRegisteredActionTool"]),
	client: Object.freeze(["createActionClient", "useConvexActionMutation"]),
	convex: Object.freeze([
		"createConvexExtensionPersistence",
		"createConvexInvocationPersistence",
		"preparePortableExtensionInstallation",
	]),
	extensions: Object.freeze([
		"ConvexExtensionPersistence",
		"createInertExtensionRevision",
		"resolveExtensionAccess",
	]),
	protocols: Object.freeze([
		"ConvexActionCliAdapter",
		"createA2AProtocolAdapter",
		"handleMcpRequest",
	]),
} as const);
