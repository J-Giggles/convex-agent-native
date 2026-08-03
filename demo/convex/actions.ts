import {
  executeRegisteredAction,
  type ExecuteRegisteredActionSecurity,
} from "@giggabit/agent-native-convex/action";
import { resolveActionScope } from "@giggabit/agent-native-convex/contracts";
import { createConvexPersistence } from "@giggabit/agent-native-convex/convex";
import { v } from "convex/values";

import { createTaskActionCatalog } from "../actions/task-actions.js";
import { components, internal } from "./_generated/api.js";
import { action, type ActionCtx } from "./_generated/server.js";
import { createConvexTaskStore } from "./tasks.js";

interface InvocationArgs {
  capability: string;
  actionName: string;
  input: unknown;
  idempotencyKey?: string;
  approvedToolCallKey?: string;
}

export async function executeDemoAction(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  args: InvocationArgs,
  caller: "frontend" | "tool" | "mcp" | "http",
  options: {
    consumeQuota?: boolean;
    security?: ExecuteRegisteredActionSecurity;
  } = {},
) {
  const session = await ctx.runMutation(internal.sessions.resolve, {
    capability: args.capability,
  });
  if (options.consumeQuota !== false) {
    await ctx.runMutation(internal.quotas.consume, {
      scopeKey: session.quotaKey,
      provenanceDigest: session.provenanceDigest,
      operation: caller === "tool" ? "chat" : "action",
      units: 1,
      now: Date.now(),
    });
  }
  const scope = resolveActionScope({
    scopeKey: session.scopeKey,
    subjectId: session.subjectId,
    ...(session.organizationId === undefined ? {} : { organizationId: session.organizationId }),
  });
  const operationKey = `${args.actionName}:${args.idempotencyKey ?? "read"}`;
  const taskStore = createConvexTaskStore(ctx, scope.scopeKey, operationKey);
  const catalog = createTaskActionCatalog(taskStore);
  const startedAt = Date.now();
  const receipt = await executeRegisteredAction(
    catalog.registry,
    createConvexPersistence(ctx, components.agentNative, scope),
    {
      actionName: args.actionName,
      input: args.input,
      caller,
      scope,
      executionContext: { taskStore },
      ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      ...(args.approvedToolCallKey === undefined
        ? {}
        : { approvedToolCallKey: args.approvedToolCallKey }),
    },
    options.security,
  );
  if (receipt.invocationId !== undefined) {
    await ctx.runMutation(internal.receipts.project, {
      scopeKey: scope.scopeKey,
      invocationId: receipt.invocationId,
      actionName: args.actionName,
      caller,
      status: "completed",
      replayed: receipt.replayed,
      createdAt: startedAt,
      updatedAt: Date.now(),
    });
  }
  return receipt;
}

export const invoke = action({
  args: {
    capability: v.string(),
    actionName: v.string(),
    input: v.any(),
    idempotencyKey: v.optional(v.string()),
    approvedToolCallKey: v.optional(v.string()),
  },
  handler: (ctx, args) => executeDemoAction(ctx, args, "frontend"),
});
