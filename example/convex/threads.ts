import { Agent, vStreamArgs } from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { components } from "./_generated/api";
import { action, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireHostScope } from "./auth";
import { requireExampleLanguageModel } from "./model";
import { enforceActionRateLimit, enforceMutationRateLimit } from "./rateLimit";

function assistant() {
	return new Agent(components.agent, {
		name: "Example assistant",
		languageModel: requireExampleLanguageModel(),
		instructions: "Be concise and never infer access outside the current thread.",
	});
}

async function hasThread(ctx: Pick<QueryCtx, "db">, scopeKey: string, threadId: string) {
	return ctx.db
		.query("threadScopes")
		.withIndex("by_scope_thread", (q) => q.eq("scopeKey", scopeKey).eq("threadId", threadId))
		.unique();
}

export const createThread = mutation({
	args: { title: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const scope = await requireHostScope(ctx);
		await enforceMutationRateLimit(ctx, {
			scopeKey: scope.scopeKey,
			operation: "create-thread",
		});
		const { threadId } = await assistant().createThread(ctx, {
			userId: scope.scopeKey,
			...(args.title ? { title: args.title.slice(0, 120) } : {}),
		});
		await ctx.db.insert("threadScopes", { scopeKey: scope.scopeKey, threadId });
		return { threadId };
	},
});

export const requireThread = internalQuery({
	args: { scopeKey: v.string(), threadId: v.string() },
	handler: async (ctx, args) => Boolean(await hasThread(ctx, args.scopeKey, args.threadId)),
});

export const listThreadMessages = query({
	args: {
		threadId: v.string(),
		paginationOpts: paginationOptsValidator,
		streamArgs: vStreamArgs,
	},
	handler: async (ctx, args) => {
		const scope = await requireHostScope(ctx);
		if (!(await hasThread(ctx, scope.scopeKey, args.threadId))) {
			throw new Error("Thread not found");
		}
		const page = await assistant().listMessages(ctx, {
			threadId: args.threadId,
			paginationOpts: args.paginationOpts,
		});
		const streams = await assistant().syncStreams(ctx, {
			threadId: args.threadId,
			streamArgs: args.streamArgs,
		});
		return { ...page, streams };
	},
});

export const streamReply = action({
	args: { threadId: v.string(), prompt: v.string() },
	handler: async (ctx, args) => {
		const scope = await requireHostScope(ctx);
		await enforceActionRateLimit(ctx, {
			scopeKey: scope.scopeKey,
			operation: "stream-reply",
		});
		if (args.prompt.length < 1 || args.prompt.length > 4_000) {
			throw new Error("Prompt must contain between 1 and 4000 characters");
		}
		const allowed = await ctx.runQuery(internal.threads.requireThread, {
			scopeKey: scope.scopeKey,
			threadId: args.threadId,
		});
		if (!allowed) throw new Error("Thread not found");

		const { thread } = await assistant().continueThread(ctx, {
			threadId: args.threadId,
			userId: scope.scopeKey,
		});
		await thread.streamText(
			{ prompt: args.prompt },
			{ saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
		);
		return { ok: true };
	},
});
