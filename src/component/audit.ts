import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { assertScopeKey } from "./safety.js";
import { vAuditEvent } from "./validators.js";

function toAuditEvent(document: Doc<"invocationAuditEvents">) {
	return {
		id: document._id,
		invocationId: document.invocationId,
		actionName: document.actionName,
		caller: document.caller,
		event: document.event,
		...(document.errorCode === undefined ? {} : { errorCode: document.errorCode }),
		createdAt: document.createdAt,
	};
}

export const listByInvocation = query({
	args: {
		scopeKey: v.string(),
		invocationId: v.id("invocations"),
	},
	returns: v.array(vAuditEvent),
	handler: async (ctx, args) => {
		const scopeKey = assertScopeKey(args.scopeKey);
		const invocation = await ctx.db.get(args.invocationId);
		if (!invocation || invocation.scopeKey !== scopeKey) return [];

		const events = await ctx.db
			.query("invocationAuditEvents")
			.withIndex("by_scope_invocation_created", (q) =>
				q.eq("scopeKey", scopeKey).eq("invocationId", args.invocationId),
			)
			.order("asc")
			.take(100);
		return events.map(toAuditEvent);
	},
});
