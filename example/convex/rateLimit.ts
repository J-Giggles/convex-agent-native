import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

const WINDOW_MS = 60_000;
const RATE_LIMITS = {
	"invoke-action": 30,
	"create-thread": 10,
	"stream-reply": 10,
} as const;
type RateLimitedOperation = keyof typeof RATE_LIMITS;
const vRateLimitedOperation = v.union(
	v.literal("invoke-action"),
	v.literal("create-thread"),
	v.literal("stream-reply"),
);

async function consume(
	ctx: Pick<MutationCtx, "db">,
	input: { scopeKey: string; operation: RateLimitedOperation },
) {
	const limit = RATE_LIMITS[input.operation];
	const now = Date.now();
	const current = await ctx.db
		.query("rateLimits")
		.withIndex("by_scope_operation", (q) =>
			q.eq("scopeKey", input.scopeKey).eq("operation", input.operation),
		)
		.unique();
	if (!current || now - current.windowStartedAt >= WINDOW_MS) {
		if (current) {
			await ctx.db.patch(current._id, { windowStartedAt: now, count: 1 });
		} else {
			await ctx.db.insert("rateLimits", {
				scopeKey: input.scopeKey,
				operation: input.operation,
				windowStartedAt: now,
				count: 1,
			});
		}
		return;
	}
	if (current.count >= limit) throw new Error("Rate limit exceeded");
	await ctx.db.patch(current._id, { count: current.count + 1 });
}

export const consumeActionRateLimit = internalMutation({
	args: { scopeKey: v.string(), operation: vRateLimitedOperation },
	handler: consume,
});

export function enforceMutationRateLimit(
	ctx: Pick<MutationCtx, "db">,
	input: { scopeKey: string; operation: RateLimitedOperation },
) {
	return consume(ctx, input);
}

export function enforceActionRateLimit(
	ctx: Pick<ActionCtx, "runMutation">,
	input: { scopeKey: string; operation: RateLimitedOperation },
) {
	return ctx.runMutation(internal.rateLimit.consumeActionRateLimit, input);
}
