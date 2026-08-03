import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server.js";
import { requireSession } from "./sessions.js";

const vCaller = v.union(
  v.literal("frontend"),
  v.literal("tool"),
  v.literal("mcp"),
  v.literal("http"),
);
const vStatus = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"));

function assertIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error(`Invalid ${label}`);
}

function publicReceipt(receipt: {
  invocationId: string;
  actionName: string;
  caller: "frontend" | "tool" | "mcp" | "http";
  status: "running" | "completed" | "failed";
  replayed: boolean;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    invocationId: receipt.invocationId,
    actionName: receipt.actionName,
    caller: receipt.caller,
    status: receipt.status,
    replayed: receipt.replayed,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

export const project = internalMutation({
  args: {
    scopeKey: v.string(),
    invocationId: v.string(),
    actionName: v.string(),
    caller: vCaller,
    status: vStatus,
    replayed: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertIdentifier(args.invocationId, "invocation id");
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(args.actionName)) throw new Error("Invalid action name");
    const existing = await ctx.db
      .query("actionReceipts")
      .withIndex("by_scope_invocation", (q) =>
        q.eq("scopeKey", args.scopeKey).eq("invocationId", args.invocationId),
      )
      .unique();
    if (existing) {
      if (existing.status !== "running") {
        if (
          existing.status === args.status &&
          existing.actionName === args.actionName &&
          existing.caller === args.caller
        ) {
          const replayed = existing.replayed || args.replayed;
          const updatedAt = Math.max(existing.updatedAt, args.updatedAt);
          if (replayed !== existing.replayed || updatedAt !== existing.updatedAt) {
            await ctx.db.patch(existing._id, { replayed, updatedAt });
          }
          return publicReceipt({ ...existing, replayed, updatedAt });
        }
        throw new Error("Receipt is already terminal");
      }
      if (args.status === "running" || args.updatedAt < existing.updatedAt) {
        throw new Error("Receipt cannot regress");
      }
      await ctx.db.patch(existing._id, {
        status: args.status,
        replayed: args.replayed,
        updatedAt: args.updatedAt,
      });
      return publicReceipt({ ...existing, ...args });
    }
    await ctx.db.insert("actionReceipts", args);
    return publicReceipt(args);
  },
});

export const list = query({
  args: { capability: v.string() },
  handler: async (ctx, args) => {
    const { scope } = await requireSession(ctx, args.capability);
    const receipts = await ctx.db
      .query("actionReceipts")
      .withIndex("by_scope_updated", (q) => q.eq("scopeKey", scope.scopeKey))
      .order("desc")
      .take(20);
    return receipts.map(publicReceipt);
  },
});
