import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import {
	assertActionName,
	assertActorId,
	assertErrorCode,
	assertIdempotencyKey,
	assertRequestFingerprint,
	assertScopeKey,
	sanitizeErrorMessage,
	sanitizeResult,
} from "./safety.js";
import {
	vActionCaller,
	vClaimInvocationResult,
	vInvocationRecord,
	vInvocationStatus,
} from "./validators.js";

function toInvocationRecord(document: Doc<"invocations">) {
	return {
		id: document._id,
		scopeKey: document.scopeKey,
		actionName: document.actionName,
		idempotencyKey: document.idempotencyKey,
		actorId: document.actorId,
		requestFingerprint: document.requestFingerprint,
		caller: document.caller,
		status: document.status,
		...(document.result === undefined ? {} : { result: document.result }),
		...(document.errorCode === undefined ? {} : { errorCode: document.errorCode }),
		...(document.errorMessage === undefined ? {} : { errorMessage: document.errorMessage }),
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

async function requireScopedInvocation(
	ctx: MutationCtx,
	scopeKey: string,
	invocationId: Id<"invocations">,
): Promise<Doc<"invocations">> {
	const invocation = await ctx.db.get(invocationId);
	if (!invocation || invocation.scopeKey !== scopeKey) {
		// Do not reveal whether an invocation exists in another scope.
		throw new Error("Invocation not found");
	}
	return invocation;
}

export const claim = mutation({
	args: {
		scopeKey: v.string(),
		actionName: v.string(),
		idempotencyKey: v.string(),
		actorId: v.string(),
		requestFingerprint: v.string(),
		caller: vActionCaller,
	},
	returns: vClaimInvocationResult,
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const actionName = assertActionName(args.actionName);
		const idempotencyKey = assertIdempotencyKey(args.idempotencyKey);
		const actorId = assertActorId(args.actorId);
		const requestFingerprint = assertRequestFingerprint(args.requestFingerprint);

		const existing = await ctx.db
			.query("invocations")
			.withIndex("by_scope_action_idempotency", (q) =>
				q
					.eq("scopeKey", scopeKey)
					.eq("actionName", actionName)
					.eq("idempotencyKey", idempotencyKey),
			)
			.unique();

		if (existing) {
			if (
				existing.actorId !== actorId ||
				existing.requestFingerprint !== requestFingerprint ||
				existing.caller !== args.caller
			) {
				return {
					outcome: "conflict" as const,
					invocation: toInvocationRecord(existing),
				};
			}
			return {
				outcome: existing.status === "running" ? ("in_flight" as const) : ("replay" as const),
				invocation: toInvocationRecord(existing),
			};
		}

		const now = Date.now();
		const invocationId = await ctx.db.insert("invocations", {
			scopeKey,
			actionName,
			idempotencyKey,
			actorId,
			requestFingerprint,
			caller: args.caller,
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("invocationAuditEvents", {
			scopeKey,
			invocationId,
			actionName,
			caller: args.caller,
			event: "claimed",
			createdAt: now,
		});

		const invocation = await ctx.db.get(invocationId);
		if (!invocation) throw new Error("Invocation claim did not persist");
		return {
			outcome: "claimed" as const,
			invocation: toInvocationRecord(invocation),
		};
	},
});

export const complete = mutation({
	args: {
		scopeKey: v.string(),
		invocationId: v.id("invocations"),
		result: v.any(),
	},
	returns: vInvocationRecord,
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const invocation = await requireScopedInvocation(ctx, scopeKey, args.invocationId);
		const result = sanitizeResult(args.result);
		if (invocation.status !== "running") {
			if (
				invocation.status === "completed" &&
				JSON.stringify(invocation.result) === JSON.stringify(result)
			) {
				return toInvocationRecord(invocation);
			}
			throw new Error("Invocation is already settled with another outcome");
		}

		const now = Date.now();
		await ctx.db.patch(invocation._id, {
			status: "completed",
			result,
			errorCode: undefined,
			errorMessage: undefined,
			updatedAt: now,
		});
		await ctx.db.insert("invocationAuditEvents", {
			scopeKey,
			invocationId: invocation._id,
			actionName: invocation.actionName,
			caller: invocation.caller,
			event: "completed",
			createdAt: now,
		});

		const completed = await ctx.db.get(invocation._id);
		if (!completed) throw new Error("Invocation completion did not persist");
		return toInvocationRecord(completed);
	},
});

export const fail = mutation({
	args: {
		scopeKey: v.string(),
		invocationId: v.id("invocations"),
		errorCode: v.string(),
		errorMessage: v.string(),
	},
	returns: vInvocationRecord,
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const invocation = await requireScopedInvocation(ctx, scopeKey, args.invocationId);
		const errorCode = assertErrorCode(args.errorCode);
		const errorMessage = sanitizeErrorMessage(args.errorMessage);
		if (invocation.status !== "running") {
			if (
				invocation.status === "failed" &&
				invocation.errorCode === errorCode &&
				invocation.errorMessage === errorMessage
			) {
				return toInvocationRecord(invocation);
			}
			throw new Error("Invocation is already settled with another outcome");
		}

		const now = Date.now();
		await ctx.db.patch(invocation._id, {
			status: "failed",
			errorCode,
			errorMessage,
			result: undefined,
			updatedAt: now,
		});
		await ctx.db.insert("invocationAuditEvents", {
			scopeKey,
			invocationId: invocation._id,
			actionName: invocation.actionName,
			caller: invocation.caller,
			event: "failed",
			errorCode,
			createdAt: now,
		});

		const failed = await ctx.db.get(invocation._id);
		if (!failed) throw new Error("Invocation failure did not persist");
		return toInvocationRecord(failed);
	},
});

export const get = query({
	args: {
		scopeKey: v.string(),
		invocationId: v.id("invocations"),
	},
	returns: v.union(vInvocationRecord, v.null()),
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const invocation = await ctx.db.get(args.invocationId);
		return invocation?.scopeKey === scopeKey ? toInvocationRecord(invocation) : null;
	},
});

export const list = query({
	args: {
		scopeKey: v.string(),
		status: v.optional(vInvocationStatus),
		limit: v.optional(v.number()),
	},
	returns: v.array(vInvocationRecord),
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const limit = args.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("limit must be an integer between 1 and 100");
		}

		const invocations = args.status
			? await ctx.db
					.query("invocations")
					.withIndex("by_scope_status_updated", (q) =>
						q.eq("scopeKey", scopeKey).eq("status", args.status!),
					)
					.order("desc")
					.take(limit)
			: await ctx.db
					.query("invocations")
					.withIndex("by_scope_updated", (q) => q.eq("scopeKey", scopeKey))
					.order("desc")
					.take(limit);
		return invocations.map(toInvocationRecord);
	},
});
