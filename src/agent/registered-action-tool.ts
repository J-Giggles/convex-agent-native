import type { ActionDefinition } from "@agent-native/core/action";
import { createTool, type ToolCtx } from "@convex-dev/agent";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
	executeRegisteredAction,
	type ExecuteRegisteredActionResult,
	type ExecuteRegisteredActionSecurity,
} from "../action/execute.js";
import type { ActionRegistry } from "../action/registry.js";
import type { ResolvedActionScope } from "../contracts/scope.js";
import type { InvocationPersistence } from "../persistence/invocations.js";

/** Stable portion of the AI SDK execution context passed to host policy. */
export interface RegisteredActionToolCall {
	readonly toolCallId: string;
	readonly messages: readonly unknown[];
	readonly abortSignal?: AbortSignal;
	readonly experimental_context?: unknown;
}

/**
 * Trusted per-call capabilities supplied by the Convex host. The callback that
 * returns this value is the appropriate place to enforce a durable quota.
 */
export interface RegisteredActionToolExecution {
	readonly persistence: InvocationPersistence;
	readonly scope: ResolvedActionScope;
	readonly idempotencyKey?: string;
	readonly approvedToolCallKey?: string;
	readonly security?: ExecuteRegisteredActionSecurity;
	readonly networkProtocol?: "a2a" | "mcp" | "provider-api";
	readonly networkId?: string;
	readonly networkPeer?: string;
	readonly executionContext?: unknown;
}

export interface CreateRegisteredActionToolOptions<Context extends ToolCtx = ToolCtx> {
	readonly registry: ActionRegistry;
	readonly actionName: string;
	/** Optional context when defining the tool inside a Convex action. */
	readonly ctx?: Context;
	/**
	 * Resolves host-owned scope and persistence for this call. It may throw to
	 * refuse the call, including when a server-side quota is exhausted.
	 */
	readonly prepareExecution: (
		ctx: Context,
		input: unknown,
		call: RegisteredActionToolCall,
	) => RegisteredActionToolExecution | Promise<RegisteredActionToolExecution>;
	/** Return the dispatcher receipt instead of only its model-visible result. */
	readonly returnInvocationEnvelope?: boolean;
}

type RuntimeActionDefinition = ActionDefinition<unknown, unknown> & {
	readonly schema?: StandardSchemaV1;
};

/**
 * Mirror the upstream approval gate for the AI SDK tool: a consequential public
 * action or `needsApproval: true` always pauses, and a predicate is evaluated
 * on the validated tool input with a throwing predicate counted as `true`, so a
 * broken gate can never silently allow a run.
 */
function toolNeedsApproval(
	actionName: string,
	definition: RuntimeActionDefinition,
): boolean | ((ctx: unknown, input: unknown) => Promise<boolean>) {
	if (definition.publicAgent?.isConsequential === true) return true;
	const gate = definition.needsApproval;
	if (typeof gate !== "function") return gate === true;
	return async (_ctx: unknown, input: unknown) => {
		try {
			return Boolean(await gate(input, { caller: "tool", actionName }));
		} catch {
			return true;
		}
	};
}

/**
 * Adapt one registered Builder-style action for `@convex-dev/agent` and AI SDK
 * without introducing a second execution path.
 */
export function createRegisteredActionTool<Context extends ToolCtx = ToolCtx>(
	options: CreateRegisteredActionToolOptions<Context>,
): ReturnType<typeof createTool> {
	const registered = options.registry.get(options.actionName);
	const definition = registered.definition as RuntimeActionDefinition;
	if (definition.schema === undefined) {
		throw new Error(
			`Registered action ${options.actionName} requires a Standard Schema to become an agent tool`,
		);
	}
	const isReadOnly = definition.readOnly === true || definition.publicAgent?.readOnly === true;

	return createTool({
		...(options.ctx === undefined ? {} : { ctx: options.ctx }),
		description: definition.tool.description,
		inputSchema: definition.schema,
		needsApproval: toolNeedsApproval(options.actionName, definition),
		async execute(ctx, input, call) {
			const execution = await options.prepareExecution(ctx, input, call);
			const receipt = await executeRegisteredAction(
				options.registry,
				execution.persistence,
				{
					actionName: options.actionName,
					input,
					caller: "tool",
					scope: execution.scope,
					...((execution.idempotencyKey ?? (!isReadOnly ? call.toolCallId : undefined)) ===
					undefined
						? {}
						: {
								idempotencyKey: execution.idempotencyKey ?? call.toolCallId,
							}),
					...(execution.approvedToolCallKey === undefined
						? {}
						: { approvedToolCallKey: execution.approvedToolCallKey }),
					...(execution.networkProtocol === undefined
						? {}
						: { networkProtocol: execution.networkProtocol }),
					...(execution.networkId === undefined ? {} : { networkId: execution.networkId }),
					...(execution.networkPeer === undefined ? {} : { networkPeer: execution.networkPeer }),
					...(execution.executionContext === undefined
						? {}
						: { executionContext: execution.executionContext }),
				},
				execution.security,
			);
			return options.returnInvocationEnvelope ? receipt : receipt.result;
		},
	});
}

export type RegisteredActionToolReceipt = ExecuteRegisteredActionResult;
