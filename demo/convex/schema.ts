import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  demoSessions: defineTable({
    publicId: v.string(),
    secretDigest: v.string(),
    provenanceDigest: v.string(),
    scopeKey: v.string(),
    expiresAt: v.number(),
    resetVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_scope", ["scopeKey"]),
  quotaBuckets: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
  tasks: defineTable({
    scopeKey: v.string(),
    title: v.string(),
    done: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastInvocationId: v.optional(v.string()),
  }).index("by_scope_order", ["scopeKey", "sortOrder"]),
  taskOperations: defineTable({
    scopeKey: v.string(),
    operationKey: v.string(),
    actionName: v.string(),
    taskId: v.optional(v.id("tasks")),
    createdAt: v.number(),
  }).index("by_scope_operation", ["scopeKey", "operationKey"]),
  chatMessages: defineTable({
    scopeKey: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_scope_created", ["scopeKey", "createdAt"]),
  chatPendingDeletes: defineTable({
    scopeKey: v.string(),
    taskId: v.id("tasks"),
    taskTitle: v.string(),
    createdAt: v.number(),
  }).index("by_scope", ["scopeKey"]),
  actionReceipts: defineTable({
    scopeKey: v.string(),
    invocationId: v.string(),
    actionName: v.string(),
    caller: v.union(v.literal("frontend"), v.literal("tool"), v.literal("mcp"), v.literal("http")),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    replayed: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scope_updated", ["scopeKey", "updatedAt"])
    .index("by_scope_invocation", ["scopeKey", "invocationId"]),
});
