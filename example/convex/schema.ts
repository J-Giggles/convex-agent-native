import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	counters: defineTable({
		scopeKey: v.string(),
		value: v.number(),
	}).index("by_scope", ["scopeKey"]),
	threadScopes: defineTable({
		scopeKey: v.string(),
		threadId: v.string(),
	}).index("by_scope_thread", ["scopeKey", "threadId"]),

	rateLimits: defineTable({
		scopeKey: v.string(),
		operation: v.string(),
		windowStartedAt: v.number(),
		count: v.number(),
	}).index("by_scope_operation", ["scopeKey", "operation"]),
});
