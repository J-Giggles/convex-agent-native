import { v } from "convex/values";

import type { Id } from "./_generated/dataModel.js";

import { handleDemoChat, type ChatResult } from "../agent/chat-service.js";
import { resolveDemoAgentProvider } from "../agent/provider.js";
import type { Task } from "../actions/task-actions.js";
import { executeDemoAction } from "./actions.js";
import { internal } from "./_generated/api.js";
import { action } from "./_generated/server.js";

export const send = action({
  args: { capability: v.string(), prompt: v.string() },
  handler: async (ctx, args): Promise<ChatResult> => {
    const session: {
      scopeKey: string;
      subjectId: string;
      organizationId: string | undefined;
      provenanceDigest: string;
    } = await ctx.runMutation(internal.sessions.resolve, {
      capability: args.capability,
    });
    await ctx.runMutation(internal.quotas.consume, {
      scopeKey: session.scopeKey,
      provenanceDigest: session.provenanceDigest,
      operation: "chat",
      units: 1,
      now: Date.now(),
    });
    const provider = resolveDemoAgentProvider({
      DEMO_AGENT_PROVIDER: process.env.DEMO_AGENT_PROVIDER,
      DEMO_AGENT_PROVIDER_ENABLED: process.env.DEMO_AGENT_PROVIDER_ENABLED,
    });
    return handleDemoChat(args.prompt, {
      listTasks: (): Promise<Task[]> =>
        ctx.runQuery(internal.tasks.listForAction, {
          scopeKey: session.scopeKey,
          includeDone: true,
        }),
      invoke: async (actionName, input, options) => {
        const approvalGrant = options.approved ? `chat:${crypto.randomUUID()}` : undefined;
        return executeDemoAction(
          ctx,
          {
            capability: args.capability,
            actionName,
            input,
            ...(actionName === "list-tasks" ? {} : { idempotencyKey: options.idempotencyKey }),
            ...(approvalGrant === undefined ? {} : { approvedToolCallKey: approvalGrant }),
          },
          "tool",
          {
            consumeQuota: false,
            ...(approvalGrant === undefined
              ? {}
              : {
                  security: {
                    approvalVerifier: {
                      verifyAndConsume: async (request) =>
                        request.approvalGrant === approvalGrant &&
                        request.scopeKey === session.scopeKey &&
                        request.actorId === session.subjectId &&
                        request.actionName === actionName,
                    },
                  },
                }),
          },
        );
      },
      append: async (role, content) => {
        await ctx.runMutation(internal.chat.append, {
          scopeKey: session.scopeKey,
          role,
          content,
          now: Date.now(),
        });
      },
      claimPendingDelete: async (): Promise<{ taskId: string; taskTitle: string } | null> => {
        const pending = await ctx.runMutation(internal.chat.claimPendingDelete, {
          scopeKey: session.scopeKey,
        });
        return pending === null
          ? null
          : { taskId: String(pending.taskId), taskTitle: pending.taskTitle };
      },
      setPendingDelete: async (pending) => {
        await ctx.runMutation(internal.chat.setPendingDelete, {
          scopeKey: session.scopeKey,
          taskId: pending.taskId as Id<"tasks">,
          taskTitle: pending.taskTitle,
          now: Date.now(),
        });
      },
      nextIdempotencyKey: () => `chat-${crypto.randomUUID()}`,
    }, provider.plan);
  },
});
