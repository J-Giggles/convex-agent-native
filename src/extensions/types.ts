const extensionAccessBrand: unique symbol = Symbol("agent-native-convex.extension-access");

export type ExtensionRole = "owner" | "admin" | "editor" | "viewer";
export type ExtensionVisibility = "private" | "organization";
export type ExtensionStorageScope = "user" | "organization";

/** Host-authenticated identity and organization scope. Never deserialize it. */
export interface ResolvedExtensionAccess {
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly organizationId?: string;
	readonly role: ExtensionRole;
	readonly [extensionAccessBrand]: true;
}

function boundedIdentifier(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) {
		throw new ExtensionSecurityError(
			"INVALID_SCOPE",
			`${label} must be a bounded non-empty identifier`,
		);
	}
	return normalized;
}

export function resolveExtensionAccess(input: {
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly organizationId?: string;
	readonly role: ExtensionRole;
}): ResolvedExtensionAccess {
	const organizationId = input.organizationId?.trim();
	if (input.organizationId !== undefined && !organizationId) {
		throw new ExtensionSecurityError(
			"INVALID_SCOPE",
			"organizationId must be non-empty when provided",
		);
	}
	if (organizationId && organizationId.length > 256) {
		throw new ExtensionSecurityError("INVALID_SCOPE", "organizationId is too long");
	}
	return Object.freeze({
		scopeKey: boundedIdentifier(input.scopeKey, "scopeKey"),
		subjectId: boundedIdentifier(input.subjectId, "subjectId"),
		...(organizationId === undefined ? {} : { organizationId }),
		role: input.role,
		[extensionAccessBrand]: true as const,
	});
}

export function isResolvedExtensionAccess(value: unknown): value is ResolvedExtensionAccess {
	return Boolean(
		value &&
		typeof value === "object" &&
		extensionAccessBrand in value &&
		(value as Record<PropertyKey, unknown>)[extensionAccessBrand] === true,
	);
}

export type ExtensionSecurityErrorCode =
	| "INVALID_SCOPE"
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "CONSENT_REQUIRED"
	| "BRIDGE_DENIED"
	| "UNSAFE_CONTENT"
	| "PAYLOAD_TOO_LARGE"
	| "PERSISTENCE_FAILURE";

export class ExtensionSecurityError extends Error {
	constructor(
		readonly code: ExtensionSecurityErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ExtensionSecurityError";
	}
}

export interface ExtensionManifest {
	readonly slots: readonly string[];
	readonly requestedActions: readonly string[];
	readonly requestedCommands: readonly string[];
	readonly storageScopes: readonly ExtensionStorageScope[];
}

export interface ExtensionRecord {
	readonly id: string;
	readonly scopeKey: string;
	readonly organizationId?: string;
	readonly name: string;
	readonly description: string;
	readonly visibility: ExtensionVisibility;
	readonly manifest: ExtensionManifest;
	readonly currentRevision: number;
	readonly currentContentHash: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface InertExtensionRenderPolicy {
	readonly mode: "inert-text";
	readonly sandbox: readonly string[];
	readonly csp: string;
}

export interface ExtensionRevisionDraft {
	readonly extensionId: string;
	readonly content: string;
	readonly contentHash: string;
	readonly summary?: string;
	readonly renderPolicy: InertExtensionRenderPolicy;
}

export interface ExtensionRevisionRecord extends ExtensionRevisionDraft {
	readonly scopeKey: string;
	readonly revision: number;
	readonly createdAt: number;
}

export interface AppendExtensionRevisionResult {
	readonly extension: ExtensionRecord;
	readonly revision: ExtensionRevisionRecord;
}

export interface ExtensionConsentRecord {
	readonly extensionId: string;
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly contentHash: string;
	readonly grantedAt: number;
}

export interface ExtensionDataRecord<TData = unknown> {
	readonly id: string;
	readonly extensionId: string;
	readonly collection: string;
	readonly storageScope: ExtensionStorageScope;
	readonly scopeKey: string;
	readonly data: TData;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ExtensionDataKey {
	readonly collection: string;
	readonly itemId: string;
	readonly storageScope: ExtensionStorageScope;
}

export interface SetExtensionDataInput extends ExtensionDataKey {
	readonly data: unknown;
}

export interface ExtensionReader {
	getExtension(
		access: ResolvedExtensionAccess,
		extensionId: string,
	): Promise<ExtensionRecord | null>;
	listExtensions(access: ResolvedExtensionAccess): Promise<readonly ExtensionRecord[]>;
	listRevisions(
		access: ResolvedExtensionAccess,
		extensionId: string,
	): Promise<readonly ExtensionRevisionRecord[]>;
	getConsent(
		access: ResolvedExtensionAccess,
		extensionId: string,
	): Promise<ExtensionConsentRecord | null>;
	listData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: Omit<ExtensionDataKey, "itemId"> & { readonly limit?: number },
	): Promise<readonly ExtensionDataRecord[]>;
	getData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: ExtensionDataKey,
	): Promise<ExtensionDataRecord | null>;
}

export interface ExtensionWriter {
	appendRevision(
		access: ResolvedExtensionAccess,
		input: ExtensionRevisionDraft,
	): Promise<AppendExtensionRevisionResult>;
	grantConsent(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
	): Promise<ExtensionConsentRecord>;
	setData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: SetExtensionDataInput,
	): Promise<ExtensionDataRecord>;
	removeData(
		access: ResolvedExtensionAccess,
		extension: ExtensionRecord,
		input: ExtensionDataKey,
	): Promise<{ readonly removed: boolean }>;
}

export type ExtensionPersistence = ExtensionReader & ExtensionWriter;
