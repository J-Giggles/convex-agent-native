import type { FunctionReference } from "convex/server";

import {
	assertExtensionScope,
	assertExtensionStorageAccess,
	assertExtensionDataKey,
	assertSafeExtensionRevision,
	assertSafeExtensionData,
} from "./policy.js";
import {
	ExtensionSecurityError,
	isResolvedExtensionAccess,
	type AppendExtensionRevisionResult,
	type ExtensionConsentRecord,
	type ExtensionDataKey,
	type ExtensionDataRecord,
	type ExtensionPersistence,
	type ExtensionRecord,
	type ExtensionRevisionDraft,
	type ExtensionRevisionRecord,
	type ResolvedExtensionAccess,
	type SetExtensionDataInput,
} from "./types.js";

interface ConvexScopeArgs extends Record<string, unknown> {
	scopeKey: string;
	subjectId: string;
	organizationId?: string;
	role: string;
}

type Query<Args extends Record<string, unknown>, Result> = FunctionReference<
	"query",
	"internal",
	Args,
	Result
>;
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<
	"mutation",
	"internal",
	Args,
	Result
>;

export interface ConvexExtensionFunctionRunner {
	query<Args extends Record<string, unknown>, Result>(
		reference: Query<Args, Result>,
		args: Args,
	): Promise<Result>;
	mutation<Args extends Record<string, unknown>, Result>(
		reference: Mutation<Args, Result>,
		args: Args,
	): Promise<Result>;
}

export interface ConvexExtensionFunctions {
	readonly getExtension: Query<ConvexScopeArgs & { extensionId: string }, ExtensionRecord | null>;
	readonly listExtensions: Query<ConvexScopeArgs, ExtensionRecord[]>;
	readonly appendRevision: Mutation<
		ConvexScopeArgs & ExtensionRevisionDraft,
		AppendExtensionRevisionResult
	>;
	readonly listRevisions: Query<
		ConvexScopeArgs & { extensionId: string },
		ExtensionRevisionRecord[]
	>;
	readonly getConsent: Query<
		ConvexScopeArgs & { extensionId: string },
		ExtensionConsentRecord | null
	>;
	readonly grantConsent: Mutation<
		ConvexScopeArgs & { extensionId: string; contentHash: string },
		ExtensionConsentRecord
	>;
	readonly listData: Query<
		ConvexScopeArgs & {
			extensionId: string;
			collection: string;
			storageScope: string;
			limit: number;
		},
		ExtensionDataRecord[]
	>;
	readonly getData: Query<
		ConvexScopeArgs & {
			extensionId: string;
			collection: string;
			itemId: string;
			storageScope: string;
		},
		ExtensionDataRecord | null
	>;
	readonly setData: Mutation<
		ConvexScopeArgs & {
			extensionId: string;
			collection: string;
			itemId: string;
			storageScope: string;
			data: unknown;
		},
		ExtensionDataRecord
	>;
	readonly removeData: Mutation<
		ConvexScopeArgs & {
			extensionId: string;
			collection: string;
			itemId: string;
			storageScope: string;
		},
		{ removed: boolean }
	>;
}

function scopeArgs(access: ResolvedExtensionAccess): ConvexScopeArgs {
	if (!isResolvedExtensionAccess(access)) {
		throw new ExtensionSecurityError(
			"INVALID_SCOPE",
			"Extension access must be resolved by the host",
		);
	}
	return {
		scopeKey: access.scopeKey,
		subjectId: access.subjectId,
		...(access.organizationId === undefined ? {} : { organizationId: access.organizationId }),
		role: access.role,
	};
}

function assertExtensionResult(
	access: ResolvedExtensionAccess,
	extension: ExtensionRecord,
	expectedId?: string,
): void {
	assertExtensionScope(access, extension);
	if (expectedId !== undefined && extension.id !== expectedId) {
		throw new ExtensionSecurityError(
			"PERSISTENCE_FAILURE",
			"Convex returned an unexpected extension record",
		);
	}
}

function assertDataResult(
	access: ResolvedExtensionAccess,
	extension: ExtensionRecord,
	record: ExtensionDataRecord,
	input: ExtensionDataKey,
): void {
	if (
		record.scopeKey !== access.scopeKey ||
		record.extensionId !== extension.id ||
		record.collection !== input.collection ||
		record.id !== input.itemId ||
		record.storageScope !== input.storageScope
	) {
		throw new ExtensionSecurityError(
			"PERSISTENCE_FAILURE",
			"Convex returned extension data outside the requested scope",
		);
	}
	assertSafeExtensionData(record.data);
}

function dataArgs(
	access: ResolvedExtensionAccess,
	extension: ExtensionRecord,
	input: ExtensionDataKey,
) {
	assertExtensionDataKey(input);
	assertExtensionStorageAccess(access, extension, input.storageScope);
	return {
		...scopeArgs(access),
		extensionId: extension.id,
		collection: input.collection,
		itemId: input.itemId,
		storageScope: input.storageScope,
	};
}

/** Convex-only implementation; all durable operations are function calls. */
export class ConvexExtensionPersistence implements ExtensionPersistence {
	constructor(
		private readonly runner: ConvexExtensionFunctionRunner,
		private readonly functions: ConvexExtensionFunctions,
	) {}

	async getExtension(access: ResolvedExtensionAccess, extensionId: string) {
		const record = await this.runner.query(this.functions.getExtension, {
			...scopeArgs(access),
			extensionId,
		});
		if (record) assertExtensionResult(access, record, extensionId);
		return record;
	}

	async listExtensions(access: ResolvedExtensionAccess) {
		const records = await this.runner.query(this.functions.listExtensions, scopeArgs(access));
		for (const record of records) assertExtensionResult(access, record);
		return records;
	}

	async appendRevision(access: ResolvedExtensionAccess, input: ExtensionRevisionDraft) {
		await assertSafeExtensionRevision(input);
		const result = await this.runner.mutation(this.functions.appendRevision, {
			...scopeArgs(access),
			...input,
		});
		assertExtensionResult(access, result.extension, input.extensionId);
		if (
			result.revision.scopeKey !== access.scopeKey ||
			result.revision.extensionId !== input.extensionId ||
			result.revision.contentHash !== input.contentHash ||
			result.extension.currentContentHash !== input.contentHash
		) {
			throw new ExtensionSecurityError(
				"PERSISTENCE_FAILURE",
				"Convex returned an inconsistent extension revision",
			);
		}
		return result;
	}

	async listRevisions(access: ResolvedExtensionAccess, extensionId: string) {
		const records = await this.runner.query(this.functions.listRevisions, {
			...scopeArgs(access),
			extensionId,
		});
		if (
			records.some(
				(record) => record.scopeKey !== access.scopeKey || record.extensionId !== extensionId,
			)
		) {
			throw new ExtensionSecurityError(
				"PERSISTENCE_FAILURE",
				"Convex returned revisions outside the requested scope",
			);
		}
		return records;
	}

	async getConsent(access: ResolvedExtensionAccess, extensionId: string) {
		const consent = await this.runner.query(this.functions.getConsent, {
			...scopeArgs(access),
			extensionId,
		});
		if (
			consent &&
			(consent.scopeKey !== access.scopeKey ||
				consent.subjectId !== access.subjectId ||
				consent.extensionId !== extensionId)
		) {
			throw new ExtensionSecurityError(
				"PERSISTENCE_FAILURE",
				"Convex returned consent outside the requested scope",
			);
		}
		return consent;
	}

	async grantConsent(access: ResolvedExtensionAccess, extension: ExtensionRecord) {
		assertExtensionResult(access, extension);
		const consent = await this.runner.mutation(this.functions.grantConsent, {
			...scopeArgs(access),
			extensionId: extension.id,
			contentHash: extension.currentContentHash,
		});
		if (
			consent.scopeKey !== access.scopeKey ||
			consent.subjectId !== access.subjectId ||
			consent.extensionId !== extension.id ||
			consent.contentHash !== extension.currentContentHash
		) {
			throw new ExtensionSecurityError(
				"PERSISTENCE_FAILURE",
				"Convex returned inconsistent extension consent",
			);
		}
		return consent;
	}

	async listData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: Omit<ExtensionDataKey, "itemId"> & { readonly limit?: number },
	) {
		assertExtensionDataKey(input);
		assertExtensionStorageAccess(access, extension, input.storageScope);
		const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 100));
		const records = await this.runner.query(this.functions.listData, {
			...scopeArgs(access),
			extensionId: extension.id,
			collection: input.collection,
			storageScope: input.storageScope,
			limit,
		});
		for (const record of records) {
			assertDataResult(access, extension, record, {
				...input,
				itemId: record.id,
			});
		}
		return records;
	}

	async getData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: ExtensionDataKey,
	) {
		const record = await this.runner.query(
			this.functions.getData,
			dataArgs(access, extension, input),
		);
		if (record) assertDataResult(access, extension, record, input);
		return record;
	}

	async setData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: SetExtensionDataInput,
	) {
		assertSafeExtensionData(input.data);
		const record = await this.runner.mutation(this.functions.setData, {
			...dataArgs(access, extension, input),
			data: input.data,
		});
		assertDataResult(access, extension, record, input);
		return record;
	}

	removeData(access: ResolvedExtensionAccess, extension: ExtensionRecord, input: ExtensionDataKey) {
		return this.runner.mutation(this.functions.removeData, dataArgs(access, extension, input));
	}
}
