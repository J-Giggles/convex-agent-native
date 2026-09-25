/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex codegen --component-dir ./src/component`.
 * @module
 */

import type { FunctionReference } from "convex/server";

type ActionCaller =
	| "tool"
	| "http"
	| "frontend"
	| "cli"
	| "mcp"
	| "a2a"
	| "webmcp"
	| "automation"
	| "extension";
type InvocationStatus = "running" | "completed" | "failed";
type ExtensionRole = "owner" | "admin" | "editor" | "viewer";
type ExtensionVisibility = "private" | "organization";
type ExtensionStorageScope = "user" | "organization";
type ExtensionAccessArgs = {
	scopeKey: string;
	subjectId: string;
	organizationId?: string;
	role: ExtensionRole;
};
type ExtensionManifest = {
	slots: string[];
	requestedActions: string[];
	requestedCommands: string[];
	storageScopes: ExtensionStorageScope[];
};
type InertRenderPolicy = { mode: "inert-text"; sandbox: string[]; csp: string };
type ExtensionRecord = {
	id: string;
	scopeKey: string;
	organizationId?: string;
	name: string;
	description: string;
	visibility: ExtensionVisibility;
	manifest: ExtensionManifest;
	currentRevision: number;
	currentContentHash: string;
	createdAt: number;
	updatedAt: number;
};
type ExtensionRevisionRecord = {
	extensionId: string;
	scopeKey: string;
	revision: number;
	content: string;
	contentHash: string;
	summary?: string;
	renderPolicy: InertRenderPolicy;
	createdAt: number;
};
type RevisionDraft = {
	extensionId: string;
	content: string;
	contentHash: string;
	summary?: string;
	renderPolicy: InertRenderPolicy;
};
type ExtensionConsentRecord = {
	extensionId: string;
	scopeKey: string;
	subjectId: string;
	contentHash: string;
	grantedAt: number;
};
type ExtensionDataRecord = {
	id: string;
	extensionId: string;
	collection: string;
	storageScope: ExtensionStorageScope;
	scopeKey: string;
	data: any;
	createdAt: number;
	updatedAt: number;
};

type InvocationRecord = {
	id: string;
	scopeKey: string;
	actionName: string;
	idempotencyKey: string;
	actorId: string;
	requestFingerprint: string;
	caller: ActionCaller;
	status: InvocationStatus;
	result?: any;
	errorCode?: string;
	errorMessage?: string;
	createdAt: number;
	updatedAt: number;
};

export type ComponentApi<Name extends string | undefined = string | undefined> = {
	audit: {
		listByInvocation: FunctionReference<
			"query",
			"internal",
			{ scopeKey: string; invocationId: string },
			Array<{
				id: string;
				invocationId: string;
				actionName: string;
				caller: ActionCaller;
				event: "claimed" | "completed" | "failed";
				errorCode?: string;
				createdAt: number;
			}>,
			Name
		>;
	};
	extensions: {
		installPortable: FunctionReference<
			"mutation",
			"internal",
			ExtensionAccessArgs &
				RevisionDraft & {
					name: string;
					description: string;
					visibility: ExtensionVisibility;
					manifest: ExtensionManifest;
				},
			{ extension: ExtensionRecord; revision: ExtensionRevisionRecord },
			Name
		>;
		getExtension: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs & { extensionId: string },
			ExtensionRecord | null,
			Name
		>;
		listExtensions: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs,
			ExtensionRecord[],
			Name
		>;
		appendRevision: FunctionReference<
			"mutation",
			"internal",
			ExtensionAccessArgs & RevisionDraft,
			{ extension: ExtensionRecord; revision: ExtensionRevisionRecord },
			Name
		>;
		listRevisions: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs & { extensionId: string },
			ExtensionRevisionRecord[],
			Name
		>;
		getConsent: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs & { extensionId: string },
			ExtensionConsentRecord | null,
			Name
		>;
		grantConsent: FunctionReference<
			"mutation",
			"internal",
			ExtensionAccessArgs & { extensionId: string; contentHash: string },
			ExtensionConsentRecord,
			Name
		>;
		listData: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs & {
				extensionId: string;
				collection: string;
				storageScope: ExtensionStorageScope;
				limit: number;
			},
			ExtensionDataRecord[],
			Name
		>;
		getData: FunctionReference<
			"query",
			"internal",
			ExtensionAccessArgs & {
				extensionId: string;
				collection: string;
				itemId: string;
				storageScope: ExtensionStorageScope;
			},
			ExtensionDataRecord | null,
			Name
		>;
		setData: FunctionReference<
			"mutation",
			"internal",
			ExtensionAccessArgs & {
				extensionId: string;
				collection: string;
				itemId: string;
				storageScope: ExtensionStorageScope;
				data: any;
			},
			ExtensionDataRecord,
			Name
		>;
		removeData: FunctionReference<
			"mutation",
			"internal",
			ExtensionAccessArgs & {
				extensionId: string;
				collection: string;
				itemId: string;
				storageScope: ExtensionStorageScope;
			},
			{ removed: boolean },
			Name
		>;
	};
	invocations: {
		claim: FunctionReference<
			"mutation",
			"internal",
			{
				scopeKey: string;
				actionName: string;
				idempotencyKey: string;
				actorId: string;
				requestFingerprint: string;
				caller: ActionCaller;
			},
			{
				outcome: "claimed" | "in_flight" | "replay" | "conflict";
				invocation: InvocationRecord;
			},
			Name
		>;
		complete: FunctionReference<
			"mutation",
			"internal",
			{ scopeKey: string; invocationId: string; result: any },
			InvocationRecord,
			Name
		>;
		fail: FunctionReference<
			"mutation",
			"internal",
			{
				scopeKey: string;
				invocationId: string;
				errorCode: string;
				errorMessage: string;
			},
			InvocationRecord,
			Name
		>;
		get: FunctionReference<
			"query",
			"internal",
			{ scopeKey: string; invocationId: string },
			InvocationRecord | null,
			Name
		>;
		list: FunctionReference<
			"query",
			"internal",
			{ scopeKey: string; status?: InvocationStatus; limit?: number },
			Array<InvocationRecord>,
			Name
		>;
	};
};
