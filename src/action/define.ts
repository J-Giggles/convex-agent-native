import type { ActionDefinition, ActionRunContext } from "@agent-native/core/action";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ConvexActionDefinition<TInput, TResult> = ActionDefinition<TInput, TResult> & {
	readonly schema: StandardSchemaV1;
};

export interface DefineConvexActionOptions<
	TSchema extends StandardSchemaV1,
	TResult,
	TOutputSchema extends StandardSchemaV1 | undefined = undefined,
> {
	readonly description: string;
	readonly schema: TSchema;
	/** Explicit JSON Schema advertised to MCP/agent clients. Runtime input validation uses `schema`. */
	readonly toolParameters: NonNullable<ActionDefinition<unknown, unknown>["tool"]["parameters"]>;
	readonly outputSchema?: TOutputSchema;
	readonly outputErrorStrategy?: "strict";
	readonly run: (
		args: StandardSchemaV1.InferOutput<TSchema>,
		ctx?: ActionRunContext,
	) => TResult | Promise<TResult>;
	readonly audit?: ActionDefinition<unknown, unknown>["audit"];
	readonly http?: ActionDefinition<unknown, unknown>["http"];
	readonly requiresAuth?: boolean;
	readonly agentTool?: boolean;
	readonly readOnly?: boolean;
	readonly toolCallable?: boolean;
	readonly publicAgent?: ActionDefinition<unknown, unknown>["publicAgent"];
	readonly needsApproval?: ActionDefinition<StandardSchemaV1.InferOutput<TSchema>, TResult>["needsApproval"];
}

/**
 * Convex-isolate-safe constructor for the public Builder `ActionDefinition` contract.
 *
 * The pinned upstream `defineAction` eagerly links its optional SQL audit module,
 * which cannot be bundled into Convex HTTP actions even when audit is disabled.
 * This adapter retains the public schema, metadata, approval, and run contracts,
 * while the package dispatcher owns input validation and durable Convex audit.
 */
export function defineConvexAction<
	TSchema extends StandardSchemaV1,
	TResult,
	TOutputSchema extends StandardSchemaV1 | undefined = undefined,
>(
	options: DefineConvexActionOptions<TSchema, TResult, TOutputSchema>,
): ConvexActionDefinition<StandardSchemaV1.InferInput<TSchema>, TResult> {
	const run = async (
		args: StandardSchemaV1.InferOutput<TSchema>,
		ctx?: ActionRunContext,
	): Promise<TResult> => {
		const result = await options.run(args, ctx);
		if (options.outputSchema === undefined) return result;
		const validation = await options.outputSchema["~standard"].validate(result);
		if (validation.issues !== undefined) {
			throw new Error("Action output did not match outputSchema");
		}
		return validation.value as TResult;
	};

	return {
		tool: { description: options.description, parameters: options.toolParameters },
		schema: options.schema,
		run,
		...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
		...(options.outputSchema === undefined
			? {}
			: { outputErrorStrategy: options.outputErrorStrategy ?? "strict" }),
		...(options.audit === undefined ? {} : { audit: options.audit }),
		...(options.http === undefined ? {} : { http: options.http }),
		...(options.requiresAuth === undefined ? {} : { requiresAuth: options.requiresAuth }),
		...(options.agentTool === undefined ? {} : { agentTool: options.agentTool }),
		...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
		...(options.toolCallable === undefined ? {} : { toolCallable: options.toolCallable }),
		...(options.publicAgent === undefined ? {} : { publicAgent: options.publicAgent }),
		...(options.needsApproval === undefined ? {} : { needsApproval: options.needsApproval }),
	} as unknown as ConvexActionDefinition<StandardSchemaV1.InferInput<TSchema>, TResult>;
}
