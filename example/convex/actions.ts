import { ActionRegistry, executeRegisteredAction } from "@giggabit/agent-native-convex";
import { createConvexInvocationPersistence } from "@giggabit/agent-native-convex/convex";
import { defineAction } from "@agent-native/core/action";
import { v } from "convex/values";
import { z } from "zod";

import { components, internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { requireHostScope } from "./auth";
import { enforceActionRateLimit } from "./rateLimit";

export const incrementCounter = internalMutation({
	args: { scopeKey: v.string(), amount: v.number() },
	handler: async (ctx, args) => {
		const current = await ctx.db
			.query("counters")
			.withIndex("by_scope", (q) => q.eq("scopeKey", args.scopeKey))
			.unique();
		const value = (current?.value ?? 0) + args.amount;
		if (current) await ctx.db.patch(current._id, { value });
		else await ctx.db.insert("counters", { scopeKey: args.scopeKey, value });
		return { value };
	},
});

/** Reactive, scope-derived read used by the browser example. */
export const getWidget = query({
	args: {},
	handler: async (ctx) => {
		const scope = await requireHostScope(ctx);
		const current = await ctx.db
			.query("counters")
			.withIndex("by_scope", (q) => q.eq("scopeKey", scope.scopeKey))
			.unique();
		return { id: "counter", value: current?.value ?? 0 };
	},
});

export const invoke = action({
	args: {
		actionName: v.string(),
		input: v.any(),
		idempotencyKey: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const scope = await requireHostScope(ctx);
		await enforceActionRateLimit(ctx, {
			scopeKey: scope.scopeKey,
			operation: "invoke-action",
		});
		const registry = new ActionRegistry().register(
			"increment-counter",
			defineAction({
				description: "Increment the signed-in scope's example counter",
				schema: z.object({ amount: z.number().int().min(1).max(10) }),
				outputSchema: z.object({ value: z.number() }),
				outputErrorStrategy: "strict",
				audit: { enabled: false },
				run: ({ amount }) =>
					ctx.runMutation(internal.actions.incrementCounter, {
						scopeKey: scope.scopeKey,
						amount,
					}),
			}),
			{
				authorizeBeforeClaim: (_input, context) =>
					Boolean(scope.organizationId && context.orgId === scope.organizationId),
				projectReplayResult: ({ value }) => ({ value }),
			},
		);

		return executeRegisteredAction(
			registry,
			createConvexInvocationPersistence(ctx, components.agentNative, scope),
			{
				actionName: args.actionName,
				input: args.input,
				caller: "frontend",
				scope,
				...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
			},
		);
	},
});
