import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { vActionCaller, vAuditEventKind, vInvocationStatus } from "./validators.js";

export default defineSchema({
	invocations: defineTable({
		scopeKey: v.string(),
		actionName: v.string(),
		idempotencyKey: v.string(),
		actorId: v.string(),
		requestFingerprint: v.string(),
		caller: vActionCaller,
		status: vInvocationStatus,
		result: v.optional(v.any()),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_scope_action_idempotency", ["scopeKey", "actionName", "idempotencyKey"])
		.index("by_scope_updated", ["scopeKey", "updatedAt"])
		.index("by_scope_status_updated", ["scopeKey", "status", "updatedAt"]),

	/**
	 * Audit records are lifecycle projections, not arbitrary log payloads. They
	 * deliberately omit idempotency keys, results, inputs, error messages, and
	 * protocol bodies so a caller cannot turn this table into a secret sink.
	 */
	invocationAuditEvents: defineTable({
		scopeKey: v.string(),
		invocationId: v.id("invocations"),
		actionName: v.string(),
		caller: vActionCaller,
		event: vAuditEventKind,
		errorCode: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_scope_invocation_created", ["scopeKey", "invocationId", "createdAt"])
		.index("by_scope_created", ["scopeKey", "createdAt"]),

	/**
	 * Extension state is package-owned compatibility state. Conversation state
	 * stays in the official Agent child component and is intentionally absent
	 * from this schema.
	 */
	extensions: defineTable({
		scopeKey: v.string(),
		extensionId: v.string(),
		organizationId: v.optional(v.string()),
		name: v.string(),
		description: v.string(),
		visibility: v.union(v.literal("private"), v.literal("organization")),
		manifest: v.object({
			slots: v.array(v.string()),
			requestedActions: v.array(v.string()),
			requestedCommands: v.array(v.string()),
			storageScopes: v.array(v.union(v.literal("user"), v.literal("organization"))),
		}),
		currentRevision: v.number(),
		currentContentHash: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_scope_extension", ["scopeKey", "extensionId"])
		.index("by_scope_updated", ["scopeKey", "updatedAt"]),

	extensionRevisions: defineTable({
		scopeKey: v.string(),
		extensionId: v.string(),
		revision: v.number(),
		content: v.string(),
		contentHash: v.string(),
		summary: v.optional(v.string()),
		renderPolicy: v.object({
			mode: v.literal("inert-text"),
			sandbox: v.array(v.string()),
			csp: v.string(),
		}),
		createdAt: v.number(),
	})
		.index("by_scope_extension_revision", ["scopeKey", "extensionId", "revision"])
		.index("by_scope_extension_created", ["scopeKey", "extensionId", "createdAt"]),

	extensionConsents: defineTable({
		scopeKey: v.string(),
		subjectId: v.string(),
		extensionId: v.string(),
		contentHash: v.string(),
		grantedAt: v.number(),
	}).index("by_scope_subject_extension", ["scopeKey", "subjectId", "extensionId"]),

	extensionData: defineTable({
		scopeKey: v.string(),
		storagePrincipal: v.string(),
		extensionId: v.string(),
		collection: v.string(),
		itemId: v.string(),
		storageScope: v.union(v.literal("user"), v.literal("organization")),
		data: v.any(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_storage_item", [
			"scopeKey",
			"storagePrincipal",
			"extensionId",
			"collection",
			"itemId",
		])
		.index("by_storage_collection_updated", [
			"scopeKey",
			"storagePrincipal",
			"extensionId",
			"collection",
			"updatedAt",
		]),
});
