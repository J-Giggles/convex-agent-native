/* eslint-disable */
/**
 * Generated-style API utilities committed for the standalone example build.
 * Regenerate in a copied Convex app with `npx convex dev`.
 */
import type { ComponentApi as AgentComponentApi } from "@convex-dev/agent/_generated/component.js";
import type { ComponentApi as AgentNativeComponentApi } from "@giggabit/agent-native-convex/_generated/component.js";
import { anyApi, componentsGeneric, type FunctionReference } from "convex/server";

type PaginationOptions = {
	numItems: number;
	cursor: string | null;
	id?: number;
	endCursor?: string | null;
	maximumRowsRead?: number;
	maximumBytesRead?: number;
};
type StreamArgs =
	| { kind: "list"; startOrder?: number }
	| { kind: "deltas"; cursors: Array<{ streamId: string; cursor: number }> };

export const api = anyApi as unknown as {
	actions: {
		getWidget: FunctionReference<"query", "public", {}, { id: string; value: number }>;
		invoke: FunctionReference<
			"action",
			"public",
			{ actionName: string; input: any; idempotencyKey?: string },
			{ invocationId?: string; replayed: boolean; result: any }
		>;
	};
	threads: {
		createThread: FunctionReference<"mutation", "public", { title?: string }, { threadId: string }>;
		listThreadMessages: FunctionReference<
			"query",
			"public",
			{ threadId: string; paginationOpts: PaginationOptions; streamArgs?: StreamArgs },
			any
		>;
		streamReply: FunctionReference<
			"action",
			"public",
			{ threadId: string; prompt: string },
			{ ok: boolean }
		>;
	};
};
export const internal = anyApi as unknown as {
	actions: {
		incrementCounter: FunctionReference<
			"mutation",
			"internal",
			{ scopeKey: string; amount: number },
			{ value: number }
		>;
	};
	rateLimit: {
		consumeActionRateLimit: FunctionReference<
			"mutation",
			"internal",
			{
				scopeKey: string;
				operation: "invoke-action" | "create-thread" | "stream-reply";
			},
			null
		>;
	};
	threads: {
		requireThread: FunctionReference<
			"query",
			"internal",
			{ scopeKey: string; threadId: string },
			boolean
		>;
	};
};
export const components = componentsGeneric() as unknown as {
	agent: AgentComponentApi<"agent">;
	agentNative: AgentNativeComponentApi<"agentNative">;
};
