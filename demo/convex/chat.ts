import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server.js";
import { requireSession } from "./sessions.js";

const MAX_MESSAGES = 40;

function boundContent(role: "user" | "assistant", content: string): string {
  return content.trim().slice(0, role === "user" ? 500 : 2_000);
}

export const append = internalMutation({
  args: {
    scopeKey: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("chatMessages", {
      scopeKey: args.scopeKey,
      role: args.role,
      content: boundContent(args.role, args.content),
      createdAt: args.now,
    });
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_scope_created", (q) => q.eq("scopeKey", args.scopeKey))
      .order("desc")
      .collect();
    for (const message of messages.slice(MAX_MESSAGES)) await ctx.db.delete(message._id);
    return { id };
  },
});

export const setPendingDelete = internalMutation({
  args: {
    scopeKey: v.string(),
    taskId: v.id("tasks"),
    taskTitle: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.scopeKey !== args.scopeKey) throw new Error("Task not found");
    const existing = await ctx.db
      .query("chatPendingDeletes")
      .withIndex("by_scope", (q) => q.eq("scopeKey", args.scopeKey))
      .unique();
    const value = {
      taskId: args.taskId,
      taskTitle: args.taskTitle.trim().slice(0, 160),
      createdAt: args.now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("chatPendingDeletes", { scopeKey: args.scopeKey, ...value });
    }
    return { taskId: args.taskId, taskTitle: value.taskTitle };
  },
});

export const claimPendingDelete = internalMutation({
  args: { scopeKey: v.string() },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("chatPendingDeletes")
      .withIndex("by_scope", (q) => q.eq("scopeKey", args.scopeKey))
      .unique();
    if (!pending) return null;
    await ctx.db.delete(pending._id);
    return { taskId: pending.taskId, taskTitle: pending.taskTitle };
  },
});

export const list = query({
  args: { capability: v.string() },
  handler: async (ctx, args) => {
    const { scope } = await requireSession(ctx, args.capability);
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_scope_created", (q) => q.eq("scopeKey", scope.scopeKey))
      .order("asc")
      .take(MAX_MESSAGES);
    return messages.map((message) => ({
      id: message._id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
  },
});
