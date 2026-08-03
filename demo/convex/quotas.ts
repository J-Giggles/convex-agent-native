import { v } from "convex/values";

import { internalMutation, type MutationCtx } from "./_generated/server.js";

const DAY_MS = 86_400_000;
const QUOTAS = {
  "session-issue": { limit: 100, windowMs: 3_600_000 },
  action: { limit: 60, windowMs: 60_000 },
  chat: { limit: 8, windowMs: 60_000 },
  reset: { limit: 3, windowMs: 3_600_000 },
} as const;

export type QuotaOperation = keyof typeof QUOTAS;
const vQuotaOperation = v.union(
  v.literal("session-issue"),
  v.literal("action"),
  v.literal("chat"),
  v.literal("reset"),
);

interface ConsumeQuotaInput {
  scopeKey: string;
  provenanceDigest: string;
  operation: QuotaOperation;
  units: number;
  now: number;
}

function bucketStart(now: number, windowMs: number) {
  return Math.floor(now / windowMs) * windowMs;
}

function assertInput(input: ConsumeQuotaInput) {
  if (!/^[a-f0-9]{64}$/u.test(input.provenanceDigest)) throw new Error("Demo quota unavailable");
  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > 10) {
    throw new Error("Demo quota unavailable");
  }
  if (!input.scopeKey.startsWith("demo:")) throw new Error("Demo quota unavailable");
}

export async function consumeQuota(
  ctx: Pick<MutationCtx, "db">,
  input: ConsumeQuotaInput,
): Promise<{ remaining: number }> {
  assertInput(input);
  const policy = QUOTAS[input.operation];
  const operationKey = `${input.operation}:${input.scopeKey}`;
  const globalKey = "deployment:daily";
  const [operationBucket, globalBucket] = await Promise.all([
    ctx.db
      .query("quotaBuckets")
      .withIndex("by_key", (q) => q.eq("key", operationKey))
      .unique(),
    ctx.db
      .query("quotaBuckets")
      .withIndex("by_key", (q) => q.eq("key", globalKey))
      .unique(),
  ]);
  const operationStart = bucketStart(input.now, policy.windowMs);
  const globalStart = bucketStart(input.now, DAY_MS);
  const operationCount =
    operationBucket?.windowStartedAt === operationStart ? operationBucket.count : 0;
  const globalCount = globalBucket?.windowStartedAt === globalStart ? globalBucket.count : 0;
  if (operationCount + input.units > policy.limit || globalCount + input.units > 5_000) {
    throw new Error("Demo quota exceeded");
  }

  if (operationBucket) {
    await ctx.db.patch(operationBucket._id, {
      windowStartedAt: operationStart,
      count: operationCount + input.units,
    });
  } else {
    await ctx.db.insert("quotaBuckets", {
      key: operationKey,
      windowStartedAt: operationStart,
      count: input.units,
    });
  }
  if (globalBucket) {
    await ctx.db.patch(globalBucket._id, {
      windowStartedAt: globalStart,
      count: globalCount + input.units,
    });
  } else {
    await ctx.db.insert("quotaBuckets", {
      key: globalKey,
      windowStartedAt: globalStart,
      count: input.units,
    });
  }
  return { remaining: policy.limit - operationCount - input.units };
}

export const consume = internalMutation({
  args: {
    scopeKey: v.string(),
    provenanceDigest: v.string(),
    operation: vQuotaOperation,
    units: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ remaining: number }> => consumeQuota(ctx, args),
});
