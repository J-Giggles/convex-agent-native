import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import {
	extensionAccessArgs,
	vAppendExtensionRevisionResult,
	vExtensionConsentRecord,
	vExtensionDataRecord,
	vExtensionManifest,
	vExtensionRecord,
	vExtensionRevisionRecord,
	vExtensionStorageScope,
	vExtensionVisibility,
	vInertRenderPolicy,
} from "./extensionValidators.js";
import {
	assertAccess,
	assertEditor,
	assertInertRevision,
	assertManifest,
	assertMetadataLabel,
	assertName,
	assertPurposeTypedData,
	storagePrincipal,
} from "./extensionSafety.js";

type AccessArgs = {
	scopeKey: string;
	subjectId: string;
	organizationId?: string;
	role: "owner" | "admin" | "editor" | "viewer";
};

function toExtension(document: Doc<"extensions">) {
	return {
		id: document.extensionId,
		scopeKey: document.scopeKey,
		...(document.organizationId === undefined ? {} : { organizationId: document.organizationId }),
		name: document.name,
		description: document.description,
		visibility: document.visibility,
		manifest: document.manifest,
		currentRevision: document.currentRevision,
		currentContentHash: document.currentContentHash,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

function toRevision(document: Doc<"extensionRevisions">) {
	return {
		extensionId: document.extensionId,
		scopeKey: document.scopeKey,
		revision: document.revision,
		content: document.content,
		contentHash: document.contentHash,
		...(document.summary === undefined ? {} : { summary: document.summary }),
		renderPolicy: document.renderPolicy,
		createdAt: document.createdAt,
	};
}

function toConsent(document: Doc<"extensionConsents">) {
	return {
		extensionId: document.extensionId,
		scopeKey: document.scopeKey,
		subjectId: document.subjectId,
		contentHash: document.contentHash,
		grantedAt: document.grantedAt,
	};
}

function toData(document: Doc<"extensionData">) {
	return {
		id: document.itemId,
		extensionId: document.extensionId,
		collection: document.collection,
		storageScope: document.storageScope,
		scopeKey: document.scopeKey,
		data: document.data,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

async function findExtension(ctx: Pick<QueryCtx, "db">, scopeKey: string, extensionId: string) {
	return ctx.db
		.query("extensions")
		.withIndex("by_scope_extension", (q) =>
			q.eq("scopeKey", scopeKey).eq("extensionId", extensionId),
		)
		.unique();
}

async function requireExtension(
	ctx: Pick<QueryCtx, "db">,
	access: ReturnType<typeof assertAccess>,
	extensionId: string,
) {
	assertName(extensionId, "extensionId");
	const extension = await findExtension(ctx, access.scopeKey, extensionId);
	if (!extension) throw new Error("Extension not found");
	if (
		extension.visibility === "organization" &&
		(!access.organizationId || access.organizationId !== extension.organizationId)
	) {
		// Keep cross-scope and not-found outcomes indistinguishable.
		throw new Error("Extension not found");
	}
	return extension;
}

function revisionArgs(args: {
	extensionId: string;
	content: string;
	contentHash: string;
	summary?: string;
	renderPolicy: { mode: "inert-text"; sandbox: string[]; csp: string };
}) {
	return {
		extensionId: assertName(args.extensionId, "extensionId"),
		content: args.content,
		contentHash: args.contentHash,
		...(args.summary === undefined ? {} : { summary: args.summary }),
		renderPolicy: args.renderPolicy,
	};
}

const revisionDraftArgs = {
	extensionId: v.string(),
	content: v.string(),
	contentHash: v.string(),
	summary: v.optional(v.string()),
	renderPolicy: vInertRenderPolicy,
};

export const installPortable = mutation({
	args: {
		...extensionAccessArgs,
		...revisionDraftArgs,
		name: v.string(),
		description: v.string(),
		visibility: vExtensionVisibility,
		manifest: vExtensionManifest,
	},
	returns: vAppendExtensionRevisionResult,
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		assertEditor(access.role);
		assertName(args.extensionId, "extensionId");
		assertManifest(args.manifest);
		await assertInertRevision(args);
		const name = assertMetadataLabel(args.name, "name");
		const description = assertMetadataLabel(args.description, "description", true);
		if (args.visibility === "organization" && !access.organizationId) {
			throw new Error("Verified organization scope is required");
		}

		const existing = await findExtension(ctx, access.scopeKey, args.extensionId);
		if (existing) {
			if (
				existing.currentRevision === 1 &&
				existing.currentContentHash === args.contentHash &&
				existing.name === name &&
				existing.description === description &&
				existing.visibility === args.visibility &&
				JSON.stringify(existing.manifest) === JSON.stringify(args.manifest)
			) {
				const revision = await ctx.db
					.query("extensionRevisions")
					.withIndex("by_scope_extension_revision", (q) =>
						q.eq("scopeKey", access.scopeKey).eq("extensionId", args.extensionId).eq("revision", 1),
					)
					.unique();
				if (revision) return { extension: toExtension(existing), revision: toRevision(revision) };
			}
			throw new Error("Extension is already installed");
		}

		const now = Date.now();
		await ctx.db.insert("extensions", {
			scopeKey: access.scopeKey,
			extensionId: args.extensionId,
			...(args.visibility === "organization" ? { organizationId: access.organizationId! } : {}),
			name,
			description,
			visibility: args.visibility,
			manifest: args.manifest,
			currentRevision: 1,
			currentContentHash: args.contentHash,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("extensionRevisions", {
			scopeKey: access.scopeKey,
			...revisionArgs(args),
			revision: 1,
			createdAt: now,
		});
		const extension = await findExtension(ctx, access.scopeKey, args.extensionId);
		const revision = await ctx.db
			.query("extensionRevisions")
			.withIndex("by_scope_extension_revision", (q) =>
				q.eq("scopeKey", access.scopeKey).eq("extensionId", args.extensionId).eq("revision", 1),
			)
			.unique();
		if (!extension || !revision) throw new Error("Extension installation did not persist");
		return { extension: toExtension(extension), revision: toRevision(revision) };
	},
});

export const getExtension = query({
	args: { ...extensionAccessArgs, extensionId: v.string() },
	returns: v.union(vExtensionRecord, v.null()),
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		try {
			return toExtension(await requireExtension(ctx, access, args.extensionId));
		} catch {
			return null;
		}
	},
});

export const listExtensions = query({
	args: extensionAccessArgs,
	returns: v.array(vExtensionRecord),
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		const records = await ctx.db
			.query("extensions")
			.withIndex("by_scope_updated", (q) => q.eq("scopeKey", access.scopeKey))
			.order("desc")
			.take(100);
		return records
			.filter(
				(record) =>
					record.visibility !== "organization" ||
					(access.organizationId !== undefined && record.organizationId === access.organizationId),
			)
			.map(toExtension);
	},
});

export const appendRevision = mutation({
	args: { ...extensionAccessArgs, ...revisionDraftArgs },
	returns: vAppendExtensionRevisionResult,
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		assertEditor(access.role);
		await assertInertRevision(args);
		const extension = await requireExtension(ctx, access, args.extensionId);
		if (extension.currentContentHash === args.contentHash) {
			const current = await ctx.db
				.query("extensionRevisions")
				.withIndex("by_scope_extension_revision", (q) =>
					q
						.eq("scopeKey", access.scopeKey)
						.eq("extensionId", args.extensionId)
						.eq("revision", extension.currentRevision),
				)
				.unique();
			if (!current) throw new Error("Current extension revision is missing");
			return { extension: toExtension(extension), revision: toRevision(current) };
		}
		const now = Date.now();
		const revision = extension.currentRevision + 1;
		const revisionId = await ctx.db.insert("extensionRevisions", {
			scopeKey: access.scopeKey,
			...revisionArgs(args),
			revision,
			createdAt: now,
		});
		await ctx.db.patch(extension._id, {
			currentRevision: revision,
			currentContentHash: args.contentHash,
			updatedAt: now,
		});
		const [updated, storedRevision] = await Promise.all([
			ctx.db.get(extension._id),
			ctx.db.get(revisionId),
		]);
		if (!updated || !storedRevision) throw new Error("Extension revision did not persist");
		return { extension: toExtension(updated), revision: toRevision(storedRevision) };
	},
});

export const listRevisions = query({
	args: { ...extensionAccessArgs, extensionId: v.string() },
	returns: v.array(vExtensionRevisionRecord),
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		await requireExtension(ctx, access, args.extensionId);
		return (
			await ctx.db
				.query("extensionRevisions")
				.withIndex("by_scope_extension_created", (q) =>
					q.eq("scopeKey", access.scopeKey).eq("extensionId", args.extensionId),
				)
				.order("asc")
				.take(100)
		).map(toRevision);
	},
});

export const getConsent = query({
	args: { ...extensionAccessArgs, extensionId: v.string() },
	returns: v.union(vExtensionConsentRecord, v.null()),
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		await requireExtension(ctx, access, args.extensionId);
		const consent = await ctx.db
			.query("extensionConsents")
			.withIndex("by_scope_subject_extension", (q) =>
				q
					.eq("scopeKey", access.scopeKey)
					.eq("subjectId", access.subjectId)
					.eq("extensionId", args.extensionId),
			)
			.unique();
		return consent ? toConsent(consent) : null;
	},
});

export const grantConsent = mutation({
	args: { ...extensionAccessArgs, extensionId: v.string(), contentHash: v.string() },
	returns: vExtensionConsentRecord,
	handler: async (ctx, args) => {
		const access = assertAccess(args);
		const extension = await requireExtension(ctx, access, args.extensionId);
		if (args.contentHash !== extension.currentContentHash) {
			throw new Error("Consent must bind the current extension revision");
		}
		const now = Date.now();
		const current = await ctx.db
			.query("extensionConsents")
			.withIndex("by_scope_subject_extension", (q) =>
				q
					.eq("scopeKey", access.scopeKey)
					.eq("subjectId", access.subjectId)
					.eq("extensionId", args.extensionId),
			)
			.unique();
		if (current) {
			await ctx.db.patch(current._id, { contentHash: args.contentHash, grantedAt: now });
			const updated = await ctx.db.get(current._id);
			if (!updated) throw new Error("Extension consent did not persist");
			return toConsent(updated);
		}
		const id = await ctx.db.insert("extensionConsents", {
			scopeKey: access.scopeKey,
			subjectId: access.subjectId,
			extensionId: args.extensionId,
			contentHash: args.contentHash,
			grantedAt: now,
		});
		const created = await ctx.db.get(id);
		if (!created) throw new Error("Extension consent did not persist");
		return toConsent(created);
	},
});

async function dataContext(
	ctx: Pick<QueryCtx, "db">,
	args: AccessArgs & {
		extensionId: string;
		collection: string;
		storageScope: "user" | "organization";
	},
) {
	const access = assertAccess(args);
	assertName(args.collection, "collection");
	const extension = await requireExtension(ctx, access, args.extensionId);
	if (!extension.manifest.storageScopes.includes(args.storageScope)) {
		throw new Error("Extension storage scope is not allow-listed");
	}
	if (args.storageScope === "organization" && extension.visibility !== "organization") {
		throw new Error("Private extensions cannot use organization storage");
	}
	return {
		access,
		principal: storagePrincipal({
			storageScope: args.storageScope,
			subjectId: access.subjectId,
			...(access.organizationId === undefined ? {} : { organizationId: access.organizationId }),
		}),
	};
}

const dataKeyArgs = {
	...extensionAccessArgs,
	extensionId: v.string(),
	collection: v.string(),
	itemId: v.string(),
	storageScope: vExtensionStorageScope,
};

async function findData(
	ctx: Pick<QueryCtx, "db">,
	input: {
		scopeKey: string;
		principal: string;
		extensionId: string;
		collection: string;
		itemId: string;
	},
) {
	return ctx.db
		.query("extensionData")
		.withIndex("by_storage_item", (q) =>
			q
				.eq("scopeKey", input.scopeKey)
				.eq("storagePrincipal", input.principal)
				.eq("extensionId", input.extensionId)
				.eq("collection", input.collection)
				.eq("itemId", input.itemId),
		)
		.unique();
}

export const listData = query({
	args: {
		...extensionAccessArgs,
		extensionId: v.string(),
		collection: v.string(),
		storageScope: vExtensionStorageScope,
		limit: v.number(),
	},
	returns: v.array(vExtensionDataRecord),
	handler: async (ctx, args) => {
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
			throw new Error("limit must be between 1 and 100");
		}
		const { access, principal } = await dataContext(ctx, args);
		return (
			await ctx.db
				.query("extensionData")
				.withIndex("by_storage_collection_updated", (q) =>
					q
						.eq("scopeKey", access.scopeKey)
						.eq("storagePrincipal", principal)
						.eq("extensionId", args.extensionId)
						.eq("collection", args.collection),
				)
				.order("desc")
				.take(args.limit)
		).map(toData);
	},
});

export const getData = query({
	args: dataKeyArgs,
	returns: v.union(vExtensionDataRecord, v.null()),
	handler: async (ctx, args) => {
		assertName(args.itemId, "itemId");
		const { access, principal } = await dataContext(ctx, args);
		const record = await findData(ctx, {
			scopeKey: access.scopeKey,
			principal,
			extensionId: args.extensionId,
			collection: args.collection,
			itemId: args.itemId,
		});
		return record ? toData(record) : null;
	},
});

export const setData = mutation({
	args: { ...dataKeyArgs, data: v.any() },
	returns: vExtensionDataRecord,
	handler: async (ctx, args) => {
		assertName(args.itemId, "itemId");
		assertPurposeTypedData(args.data);
		const { access, principal } = await dataContext(ctx, args);
		const current = await findData(ctx, {
			scopeKey: access.scopeKey,
			principal,
			extensionId: args.extensionId,
			collection: args.collection,
			itemId: args.itemId,
		});
		const now = Date.now();
		if (current) {
			await ctx.db.patch(current._id, { data: args.data, updatedAt: now });
			const updated = await ctx.db.get(current._id);
			if (!updated) throw new Error("Extension data did not persist");
			return toData(updated);
		}
		const id = await ctx.db.insert("extensionData", {
			scopeKey: access.scopeKey,
			storagePrincipal: principal,
			extensionId: args.extensionId,
			collection: args.collection,
			itemId: args.itemId,
			storageScope: args.storageScope,
			data: args.data,
			createdAt: now,
			updatedAt: now,
		});
		const created = await ctx.db.get(id);
		if (!created) throw new Error("Extension data did not persist");
		return toData(created);
	},
});

export const removeData = mutation({
	args: dataKeyArgs,
	returns: v.object({ removed: v.boolean() }),
	handler: async (ctx, args) => {
		assertName(args.itemId, "itemId");
		const { access, principal } = await dataContext(ctx, args);
		const current = await findData(ctx, {
			scopeKey: access.scopeKey,
			principal,
			extensionId: args.extensionId,
			collection: args.collection,
			itemId: args.itemId,
		});
		if (!current) return { removed: false };
		await ctx.db.delete(current._id);
		return { removed: true };
	},
});
