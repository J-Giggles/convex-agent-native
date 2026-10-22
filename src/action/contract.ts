import type { StandardSchemaV1 } from "@standard-schema/spec";

/*
 * The package's own action contract. It mirrors the `@agent-native/core/action`
 * 0.189 shapes this package reads, so a core `ActionDefinition` is assignable to
 * it and back, while consumers resolve real types without installing core.
 * Core-runtime-only members (chat `send`/`attachments`, plan mode, links, MCP
 * apps, chat UI, access rules) are left out because this dispatcher never
 * honours them.
 */

export type ActionCaller =
	| "tool"
	| "http"
	| "frontend"
	| "cli"
	| "mcp"
	| "webmcp"
	| "a2a"
	| "automation";

export interface ActionAutomationContext {
	triggerId: string;
	triggerName: string;
	policyId?: string;
}

export interface ActionRunContext {
	userEmail?: string;
	requestHeaders?: Headers;
	orgId?: string | null;
	appId?: string;
	appRoles?: string[];
	appPermissions?: string[];
	caller: ActionCaller;
	automation?: ActionAutomationContext;
	networkProtocol?: "a2a" | "mcp" | "provider-api";
	networkId?: string;
	networkPeer?: string;
	delegationDepth?: number;
	visitedApps?: string[];
	signal?: AbortSignal;
	actionName?: string;
	threadId?: string;
	runId?: string;
	turnId?: string;
	approvedToolCallKey?: string;
}

export interface ActionJsonSchema {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, ActionJsonSchema>;
	required?: string[];
	additionalProperties?: boolean | ActionJsonSchema;
	items?: ActionJsonSchema;
	oneOf?: ActionJsonSchema[];
	anyOf?: ActionJsonSchema[];
	allOf?: ActionJsonSchema[];
	not?: ActionJsonSchema;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
}

export interface ActionTool {
	title?: string;
	description: string;
	parameters?: ActionJsonSchema & {
		type: "object";
		properties: Record<string, ActionJsonSchema>;
		required?: string[];
	};
}

export interface ActionHttpConfig {
	method?: "GET" | "POST" | "PUT" | "DELETE";
	path?: string;
}

export interface PublicAgentActionConfig {
	expose: boolean;
	readOnly: boolean;
	requiresAuth?: boolean;
	isConsequential?: boolean;
	title?: string;
	description?: string;
	allowRawQueryInput?: boolean;
}

/**
 * Upstream SQL audit switches. The dispatcher refuses enabled upstream audit and
 * records its own, so the upstream `target` and `summary` builders are not part
 * of this contract.
 */
export interface ActionAuditConfig {
	enabled?: boolean;
	onRead?: boolean;
	recordInputs?: boolean;
}

export type ActionOutputErrorStrategy = "strict" | "warn" | "fallback";

export type ActionApprovalPredicate<TInput> = (
	args: TInput,
	ctx?: ActionRunContext,
) => boolean | Promise<boolean>;

export interface ActionDefinition<TInput, TReturn> {
	readonly run: (args: TInput, ctx?: ActionRunContext) => Promise<TReturn> | TReturn;
	readonly tool: ActionTool;
	readonly http?: ActionHttpConfig | false;
	readonly requiresAuth?: boolean;
	readonly maxBodyBytes?: number;
	readonly uiOnly?: boolean;
	readonly agentTool?: boolean;
	readonly mcpTool?: boolean;
	readonly deferLoading?: boolean;
	readonly readOnly?: boolean;
	readonly grounding?: boolean;
	readonly allowInPlanMode?: boolean;
	readonly parallelSafe?: boolean;
	readonly endsTurn?: boolean;
	readonly dedupe?: boolean;
	readonly toolCallable?: boolean;
	readonly capabilityScopes?: readonly string[];
	readonly publicAgent?: PublicAgentActionConfig;
	readonly timeoutMs?: number;
	readonly maxResultChars?: number;
	readonly outputSchema?: StandardSchemaV1;
	readonly outputErrorStrategy?: ActionOutputErrorStrategy;
	readonly outputFallback?: TReturn;
	readonly needsApproval?: boolean | ActionApprovalPredicate<TInput>;
	readonly allowPersistentApproval?: boolean;
	readonly audit?: ActionAuditConfig;
}
