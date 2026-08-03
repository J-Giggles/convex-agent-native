import type { Task, TaskStore } from "../actions/task-actions.js";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, query, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { requireSession } from "./sessions.js";

function toTask(document: Doc<"tasks">): Task {
  return {
    id: document._id,
    title: document.title,
    done: document.done,
    sortOrder: document.sortOrder,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

async function scopedTask(ctx: Pick<MutationCtx, "db">, scopeKey: string, taskId: Id<"tasks">) {
  const task = await ctx.db.get(taskId);
  if (!task || task.scopeKey !== scopeKey) throw new Error("Task not found");
  return task;
}

async function priorOperation(ctx: Pick<MutationCtx, "db">, scopeKey: string, operationKey: string) {
  return ctx.db
    .query("taskOperations")
    .withIndex("by_scope_operation", (q) =>
      q.eq("scopeKey", scopeKey).eq("operationKey", operationKey),
    )
    .unique();
}

function assertOperationKey(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new Error("Invalid operation key");
}

export const listForAction = internalQuery({
  args: { scopeKey: v.string(), includeDone: v.boolean() },
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_scope_order", (q) => q.eq("scopeKey", args.scopeKey))
      .collect();
    return tasks.filter(({ done }) => args.includeDone || !done).map(toTask);
  },
});

export const createForAction = internalMutation({
  args: { scopeKey: v.string(), title: v.string(), operationKey: v.string() },
  handler: async (ctx, args) => {
    assertOperationKey(args.operationKey);
    const prior = await priorOperation(ctx, args.scopeKey, args.operationKey);
    if (prior) {
      if (prior.actionName !== "create-task" || !prior.taskId) throw new Error("Operation conflict");
      return toTask(await scopedTask(ctx, args.scopeKey, prior.taskId));
    }
    const last = await ctx.db
      .query("tasks")
      .withIndex("by_scope_order", (q) => q.eq("scopeKey", args.scopeKey))
      .order("desc")
      .first();
    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      scopeKey: args.scopeKey,
      title: args.title,
      done: false,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      createdAt: now,
      updatedAt: now,
      lastInvocationId: args.operationKey,
    });
    await ctx.db.insert("taskOperations", {
      scopeKey: args.scopeKey,
      operationKey: args.operationKey,
      actionName: "create-task",
      taskId,
      createdAt: now,
    });
    return toTask((await ctx.db.get(taskId))!);
  },
});

export const updateForAction = internalMutation({
  args: {
    scopeKey: v.string(),
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    done: v.optional(v.boolean()),
    operationKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOperationKey(args.operationKey);
    const prior = await priorOperation(ctx, args.scopeKey, args.operationKey);
    if (prior) {
      if (prior.actionName !== "update-task" || prior.taskId !== args.taskId) throw new Error("Operation conflict");
      return toTask(await scopedTask(ctx, args.scopeKey, args.taskId));
    }
    const task = await scopedTask(ctx, args.scopeKey, args.taskId);
    const updatedAt = Date.now();
    await ctx.db.patch(task._id, {
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.done === undefined ? {} : { done: args.done }),
      updatedAt,
      lastInvocationId: args.operationKey,
    });
    await ctx.db.insert("taskOperations", {
      scopeKey: args.scopeKey,
      operationKey: args.operationKey,
      actionName: "update-task",
      taskId: task._id,
      createdAt: updatedAt,
    });
    return toTask((await ctx.db.get(task._id))!);
  },
});

export const deleteForAction = internalMutation({
  args: { scopeKey: v.string(), taskId: v.id("tasks"), operationKey: v.string() },
  handler: async (ctx, args) => {
    assertOperationKey(args.operationKey);
    const prior = await priorOperation(ctx, args.scopeKey, args.operationKey);
    if (prior) {
      if (prior.actionName !== "delete-task" || prior.taskId !== args.taskId) throw new Error("Operation conflict");
      return { ok: true as const };
    }
    const task = await scopedTask(ctx, args.scopeKey, args.taskId);
    const now = Date.now();
    await ctx.db.delete(task._id);
    await ctx.db.insert("taskOperations", {
      scopeKey: args.scopeKey,
      operationKey: args.operationKey,
      actionName: "delete-task",
      taskId: task._id,
      createdAt: now,
    });
    return { ok: true as const };
  },
});

export const list = query({
  args: { capability: v.string(), includeDone: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { scope } = await requireSession(ctx, args.capability);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_scope_order", (q) => q.eq("scopeKey", scope.scopeKey))
      .collect();
    return tasks.filter(({ done }) => args.includeDone === true || !done).map(toTask);
  },
});

export function createConvexTaskStore(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  scopeKey: string,
  operationKey: string,
): TaskStore {
  return {
    scopeKey,
    list: (includeDone) => ctx.runQuery(internal.tasks.listForAction, { scopeKey, includeDone }),
    create: (title) =>
      ctx.runMutation(internal.tasks.createForAction, { scopeKey, title, operationKey }),
    update: (taskId, patch) =>
      ctx.runMutation(internal.tasks.updateForAction, {
        scopeKey,
        taskId: taskId as Id<"tasks">,
        operationKey,
        ...patch,
      }),
    delete: async (taskId) => {
      await ctx.runMutation(internal.tasks.deleteForAction, {
        scopeKey,
        taskId: taskId as Id<"tasks">,
        operationKey,
      });
    },
  };
}
