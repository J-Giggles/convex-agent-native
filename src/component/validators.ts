import { v } from "convex/values";

export const vActionCaller = v.union(
	v.literal("tool"),
	v.literal("http"),
	v.literal("frontend"),
	v.literal("cli"),
	v.literal("mcp"),
	v.literal("a2a"),
	v.literal("automation"),
	v.literal("extension"),
);

export const vInvocationStatus = v.union(
	v.literal("running"),
	v.literal("completed"),
	v.literal("failed"),
);

export const vAuditEventKind = v.union(
	v.literal("claimed"),
	v.literal("completed"),
	v.literal("failed"),
);

export const vInvocationRecord = v.object({
	id: v.string(),
	scopeKey: v.string(),
	actionName: v.string(),
	idempotencyKey: v.string(),
	actorId: v.string(),
	requestFingerprint: v.string(),
	caller: vActionCaller,
	status: vInvocationStatus,
	result: v.optional(v.any()),
	errorCode: v.optional(v.string()),
	errorMessage: v.optional(v.string()),
	createdAt: v.number(),
	updatedAt: v.number(),
});

export const vClaimInvocationResult = v.object({
	outcome: v.union(
		v.literal("claimed"),
		v.literal("in_flight"),
		v.literal("replay"),
		v.literal("conflict"),
	),
	invocation: vInvocationRecord,
});

export const vAuditEvent = v.object({
	id: v.string(),
	invocationId: v.string(),
	actionName: v.string(),
	caller: vActionCaller,
	event: vAuditEventKind,
	errorCode: v.optional(v.string()),
	createdAt: v.number(),
});
