import { v } from "convex/values";

import { capabilityDigest, parseCapability, resolveCapabilityScope } from "./capabilities.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { consumeQuota } from "./quotas.js";

const SESSION_TTL_MS = 86_400_000;
const SEED_TITLES = ["Record the demo", "Get groceries"] as const;

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function seedTasks(ctx: Pick<MutationCtx, "db">, scopeKey: string, now: number) {
  for (const [sortOrder, title] of SEED_TITLES.entries()) {
    await ctx.db.insert("tasks", { scopeKey, title, done: false, sortOrder, createdAt: now, updatedAt: now });
  }
}

async function findSession(
  ctx: Pick<QueryCtx, "db">,
  capability: string,
): Promise<Doc<"demoSessions">> {
  let parsed: ReturnType<typeof parseCapability>;
  try {
    parsed = parseCapability(capability);
  } catch {
    throw new Error("Demo session unavailable");
  }
  const session = await ctx.db
    .query("demoSessions")
    .withIndex("by_public_id", (q) => q.eq("publicId", parsed.publicId))
    .unique();
  const presentedDigest = await capabilityDigest(parsed.secret);
  if (
    !session ||
    session.expiresAt <= Date.now() ||
    !safeEqual(session.secretDigest, presentedDigest)
  ) {
    throw new Error("Demo session unavailable");
  }
  return session;
}

export async function requireSession(ctx: Pick<QueryCtx, "db">, capability: string) {
  const session = await findSession(ctx, capability);
  return { session, scope: resolveCapabilityScope(session) };
}

const issueArgs = {
  publicId: v.string(),
  secretDigest: v.string(),
  provenanceDigest: v.string(),
  now: v.number(),
};

async function issueHandler(ctx: MutationCtx, args: {
  publicId: string;
  secretDigest: string;
  provenanceDigest: string;
  now: number;
}) {
  const scope = resolveCapabilityScope(args);
  if (!/^[a-f0-9]{64}$/u.test(args.provenanceDigest)) throw new Error("Invalid provenance");
  const existing = await ctx.db
    .query("demoSessions")
    .withIndex("by_public_id", (q) => q.eq("publicId", args.publicId))
    .unique();
  if (existing) throw new Error("Demo session unavailable");
  await ctx.db.insert("demoSessions", {
    publicId: args.publicId,
    secretDigest: args.secretDigest,
    provenanceDigest: args.provenanceDigest,
    scopeKey: scope.scopeKey,
    expiresAt: args.now + SESSION_TTL_MS,
    resetVersion: 0,
    createdAt: args.now,
    updatedAt: args.now,
  });
  await seedTasks(ctx, scope.scopeKey, args.now);
  return { publicId: args.publicId, expiresAt: args.now + SESSION_TTL_MS };
}

export const issue = internalMutation({
  args: issueArgs,
  handler: issueHandler,
});

export const issueForTest = internalMutation({
  args: issueArgs,
  handler: issueHandler,
});

export const resolve = internalMutation({
  args: { capability: v.string() },
  handler: async (ctx, args) => {
    const { session, scope } = await requireSession(ctx, args.capability);
    return {
      publicId: session.publicId,
      scopeKey: scope.scopeKey,
      subjectId: scope.subjectId,
      organizationId: scope.organizationId,
      provenanceDigest: session.provenanceDigest,
      expiresAt: session.expiresAt,
    };
  },
});

export const get = query({
  args: { capability: v.string() },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.capability);
    return {
      publicId: session.publicId,
      scopeKey: session.scopeKey,
      expiresAt: session.expiresAt,
      resetVersion: session.resetVersion,
    };
  },
});

export const reset = mutation({
  args: { capability: v.string() },
  handler: async (ctx, args) => {
    const { session } = await requireSession(ctx, args.capability);
    const now = Date.now();
    await consumeQuota(ctx, {
      scopeKey: session.scopeKey,
      provenanceDigest: session.provenanceDigest,
      operation: "reset",
      units: 1,
      now,
    });
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_scope_order", (q) => q.eq("scopeKey", session.scopeKey))
      .collect();
    const chatMessages = await ctx.db
      .query("chatMessages")
      .withIndex("by_scope_created", (q) => q.eq("scopeKey", session.scopeKey))
      .collect();
    const pendingDelete = await ctx.db
      .query("chatPendingDeletes")
      .withIndex("by_scope", (q) => q.eq("scopeKey", session.scopeKey))
      .unique();
    for (const task of tasks) await ctx.db.delete(task._id);
    for (const message of chatMessages) await ctx.db.delete(message._id);
    if (pendingDelete) await ctx.db.delete(pendingDelete._id);
    await seedTasks(ctx, session.scopeKey, now);
    const resetVersion = session.resetVersion + 1;
    await ctx.db.patch(session._id, { resetVersion, updatedAt: now });
    return { resetVersion };
  },
});
