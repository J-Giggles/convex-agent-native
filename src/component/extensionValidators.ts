import { v } from "convex/values";

export const vExtensionRole = v.union(
	v.literal("owner"),
	v.literal("admin"),
	v.literal("editor"),
	v.literal("viewer"),
);
export const vExtensionVisibility = v.union(v.literal("private"), v.literal("organization"));
export const vExtensionStorageScope = v.union(v.literal("user"), v.literal("organization"));
export const vExtensionManifest = v.object({
	slots: v.array(v.string()),
	requestedActions: v.array(v.string()),
	requestedCommands: v.array(v.string()),
	storageScopes: v.array(vExtensionStorageScope),
});
export const vInertRenderPolicy = v.object({
	mode: v.literal("inert-text"),
	sandbox: v.array(v.string()),
	csp: v.string(),
});
export const vExtensionRecord = v.object({
	id: v.string(),
	scopeKey: v.string(),
	organizationId: v.optional(v.string()),
	name: v.string(),
	description: v.string(),
	visibility: vExtensionVisibility,
	manifest: vExtensionManifest,
	currentRevision: v.number(),
	currentContentHash: v.string(),
	createdAt: v.number(),
	updatedAt: v.number(),
});
export const vExtensionRevisionRecord = v.object({
	extensionId: v.string(),
	scopeKey: v.string(),
	revision: v.number(),
	content: v.string(),
	contentHash: v.string(),
	summary: v.optional(v.string()),
	renderPolicy: vInertRenderPolicy,
	createdAt: v.number(),
});
export const vAppendExtensionRevisionResult = v.object({
	extension: vExtensionRecord,
	revision: vExtensionRevisionRecord,
});
export const vExtensionConsentRecord = v.object({
	extensionId: v.string(),
	scopeKey: v.string(),
	subjectId: v.string(),
	contentHash: v.string(),
	grantedAt: v.number(),
});
export const vExtensionDataRecord = v.object({
	id: v.string(),
	extensionId: v.string(),
	collection: v.string(),
	storageScope: vExtensionStorageScope,
	scopeKey: v.string(),
	data: v.any(),
	createdAt: v.number(),
	updatedAt: v.number(),
});

export const extensionAccessArgs = {
	scopeKey: v.string(),
	subjectId: v.string(),
	organizationId: v.optional(v.string()),
	role: vExtensionRole,
};
