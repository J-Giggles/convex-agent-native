import type {
	ExtensionConsentRecord,
	ExtensionManifest,
	ExtensionRecord,
	ExtensionRevisionDraft,
	ExtensionStorageScope,
	ResolvedExtensionAccess,
} from "./types.js";
import {
	assertPurposeTypedDurableContent,
	DurableContentPolicyError,
	purposeTypedDigest,
	purposeTypedIdentifier,
} from "../component/durableContent.js";
import { ExtensionSecurityError, isResolvedExtensionAccess } from "./types.js";

const MAX_EXTENSION_CONTENT_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 64;
const MAX_TEXT_CHARS = 4_096;
const MAX_DEPTH = 8;
const SECRET_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const SECRET_VALUE =
	/(?:\$\{(?:keys|automationSecret)\.[^}]+\}|authorization\s*:|bearer\s+[A-Za-z0-9._~+\/-]{6,}|(?:token|password|secret)\s*[=:]\s*\S+)/i;
const NAME = /^[a-z][a-z0-9._-]{0,95}$/;
const UI_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const FINANCIAL_IDENTIFIER = /\b\d{8,19}\b/;

export interface ExtensionDataIdentifier {
	readonly $agentNative: "opaque-id";
	readonly purpose: string;
	readonly value: string;
}

export interface ExtensionDataDigest {
	readonly $agentNative: "sha256";
	readonly purpose: string;
	readonly value: string;
}

export function extensionDataIdentifier(purpose: string, value: string): ExtensionDataIdentifier {
	try {
		return purposeTypedIdentifier(purpose, value);
	} catch (error) {
		throw durableContentFailure(error);
	}
}

export function extensionDataDigest(purpose: string, value: string): ExtensionDataDigest {
	try {
		return purposeTypedDigest(purpose, value);
	} catch (error) {
		throw durableContentFailure(error);
	}
}

function durableContentFailure(error: unknown): ExtensionSecurityError {
	if (error instanceof DurableContentPolicyError) {
		return new ExtensionSecurityError(error.code, error.message, { cause: error });
	}
	return new ExtensionSecurityError("UNSAFE_CONTENT", "Durable extension data was refused", {
		cause: error,
	});
}

export const INERT_EXTENSION_RENDER_POLICY = Object.freeze({
	mode: "inert-text" as const,
	sandbox: Object.freeze([] as string[]),
	csp: [
		"default-src 'none'",
		"script-src 'none'",
		"style-src 'none'",
		"img-src 'none'",
		"connect-src 'none'",
		"font-src 'none'",
		"media-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; "),
});

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertName(value: string, label: string): void {
	if (!NAME.test(value)) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			`${label} must use a bounded allow-listed identifier`,
		);
	}
}

function assertNoSecrets(value: unknown, depth = 0): void {
	if (depth > MAX_DEPTH) {
		throw new ExtensionSecurityError("UNSAFE_CONTENT", "Extension payload nesting is too deep");
	}
	if (typeof value === "string") {
		if (value.length > MAX_TEXT_CHARS || SECRET_VALUE.test(value)) {
			throw new ExtensionSecurityError(
				"UNSAFE_CONTENT",
				"Extension payload contains secret-shaped or unbounded text",
			);
		}
		return;
	}
	if (value === null || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value) && Math.abs(value) >= 10_000_000) {
			throw new ExtensionSecurityError(
				"UNSAFE_CONTENT",
				"Extension payload contains a financial-identifier-shaped integer",
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_LIST_ITEMS) {
			throw new ExtensionSecurityError("PAYLOAD_TOO_LARGE", "Extension payload has too many items");
		}
		for (const item of value) assertNoSecrets(item, depth + 1);
		return;
	}
	if (value && typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ExtensionSecurityError(
				"UNSAFE_CONTENT",
				"Extension payload must use plain JSON objects",
			);
		}
		const entries = Object.entries(value);
		if (entries.length > MAX_LIST_ITEMS) {
			throw new ExtensionSecurityError(
				"PAYLOAD_TOO_LARGE",
				"Extension payload has too many fields",
			);
		}
		for (const [key, item] of entries) {
			if (SECRET_KEY.test(key)) {
				throw new ExtensionSecurityError(
					"UNSAFE_CONTENT",
					"Extension payload contains a secret-shaped field",
				);
			}
			assertNoSecrets(item, depth + 1);
		}
		return;
	}
	throw new ExtensionSecurityError(
		"UNSAFE_CONTENT",
		"Extension payload must be finite JSON-compatible data",
	);
}

export function assertSafeExtensionData(value: unknown): void {
	try {
		assertPurposeTypedDurableContent(value);
	} catch (error) {
		throw durableContentFailure(error);
	}
}

async function sha256(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

export async function assertSafeExtensionRevision(input: ExtensionRevisionDraft): Promise<void> {
	assertName(input.extensionId, "extensionId");
	if (byteLength(input.content) > MAX_EXTENSION_CONTENT_BYTES) {
		throw new ExtensionSecurityError("PAYLOAD_TOO_LARGE", "Extension content is too large");
	}
	if (SECRET_VALUE.test(input.content)) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Extension content contains secret-shaped data",
		);
	}
	const trimmedContent = input.content.trim();
	if (!trimmedContent.startsWith("<") || !trimmedContent.endsWith(">")) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Extension revisions must be static inert markup, not raw narrative content",
		);
	}
	const markupTags = trimmedContent.match(/<[^>]*>/g) ?? [];
	if (
		markupTags.some((tag) => {
			const body = tag.slice(1, -1).trim();
			if (body.startsWith("/")) return !/^\/[A-Za-z][A-Za-z0-9-]*$/.test(body);
			return !/^[A-Za-z][A-Za-z0-9-]*\/?$/.test(body);
		})
	) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Inert extension markup does not allow attributes or directives",
		);
	}
	const textNodes = trimmedContent
		.replace(/<[^>]*>/g, "\n")
		.split("\n")
		.map((text) => text.trim())
		.filter(Boolean);
	if (textNodes.some((text) => !UI_LABEL.test(text) || FINANCIAL_IDENTIFIER.test(text))) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Extension markup text must use bounded UI labels rather than narrative data",
		);
	}
	if (input.summary !== undefined) {
		assertNoSecrets(input.summary);
		if (!UI_LABEL.test(input.summary) || FINANCIAL_IDENTIFIER.test(input.summary)) {
			throw new ExtensionSecurityError(
				"UNSAFE_CONTENT",
				"Extension revision summaries must be bounded UI labels",
			);
		}
	}
	if (
		input.renderPolicy.mode !== INERT_EXTENSION_RENDER_POLICY.mode ||
		input.renderPolicy.csp !== INERT_EXTENSION_RENDER_POLICY.csp ||
		input.renderPolicy.sandbox.length !== 0
	) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Extension render policy must use the fixed inert sandbox and CSP",
		);
	}
	if (input.contentHash !== (await sha256(input.content))) {
		throw new ExtensionSecurityError(
			"UNSAFE_CONTENT",
			"Extension content hash does not match the stored content",
		);
	}
}

export async function createInertExtensionRevision(input: {
	readonly extensionId: string;
	readonly content: string;
	readonly summary?: string;
}): Promise<ExtensionRevisionDraft> {
	const draft = Object.freeze({
		extensionId: input.extensionId,
		content: input.content,
		contentHash: await sha256(input.content),
		...(input.summary === undefined ? {} : { summary: input.summary }),
		renderPolicy: INERT_EXTENSION_RENDER_POLICY,
	});
	await assertSafeExtensionRevision(draft);
	return draft;
}

export function assertExtensionDataKey(input: {
	readonly collection: string;
	readonly itemId?: string;
}): void {
	assertName(input.collection, "collection");
	if (input.itemId !== undefined) assertName(input.itemId, "itemId");
}

export function assertExtensionScope(
	access: ResolvedExtensionAccess,
	extension: Pick<ExtensionRecord, "scopeKey" | "organizationId" | "visibility">,
): void {
	if (!isResolvedExtensionAccess(access)) {
		throw new ExtensionSecurityError(
			"INVALID_SCOPE",
			"Extension access must be resolved by the host",
		);
	}
	if (extension.scopeKey !== access.scopeKey) {
		throw new ExtensionSecurityError("FORBIDDEN", "Extension is outside the resolved scope");
	}
	if (
		extension.visibility === "organization" &&
		(!extension.organizationId ||
			!access.organizationId ||
			extension.organizationId !== access.organizationId)
	) {
		throw new ExtensionSecurityError(
			"FORBIDDEN",
			"Extension organization scope does not match the viewer",
		);
	}
}

export function assertExtensionConsent(
	access: ResolvedExtensionAccess,
	extension: ExtensionRecord,
	consent: ExtensionConsentRecord | null,
): void {
	assertExtensionScope(access, extension);
	if (
		!consent ||
		consent.extensionId !== extension.id ||
		consent.scopeKey !== access.scopeKey ||
		consent.subjectId !== access.subjectId ||
		consent.contentHash !== extension.currentContentHash
	) {
		throw new ExtensionSecurityError(
			"CONSENT_REQUIRED",
			"Consent is required for the current extension revision",
		);
	}
}

function contains(list: readonly string[], value: string): boolean {
	return list.includes(value);
}

export function assertExtensionBridgeAction(input: {
	readonly caller: "extension";
	readonly access: ResolvedExtensionAccess;
	readonly extension: ExtensionRecord;
	readonly consent: ExtensionConsentRecord | null;
	readonly slotId: string;
	readonly actionName: string;
	readonly action: { readonly toolCallable?: boolean };
}): void {
	if (input.caller !== "extension") {
		throw new ExtensionSecurityError(
			"BRIDGE_DENIED",
			"Extension bridge authorization requires authentic extension caller provenance",
		);
	}
	assertExtensionConsent(input.access, input.extension, input.consent);
	if (!contains(input.extension.manifest.slots, input.slotId)) {
		throw new ExtensionSecurityError("BRIDGE_DENIED", "Extension is not allowed in this slot");
	}
	if (!contains(input.extension.manifest.requestedActions, input.actionName)) {
		throw new ExtensionSecurityError(
			"BRIDGE_DENIED",
			"Bridge action is not present in the extension manifest allowlist",
		);
	}
	if (input.action.toolCallable !== true) {
		throw new ExtensionSecurityError(
			"BRIDGE_DENIED",
			`Action ${input.actionName} is not callable from extensions`,
		);
	}
}

export function assertExtensionStorageAccess(
	access: ResolvedExtensionAccess,
	extension: ExtensionRecord,
	storageScope: ExtensionStorageScope,
): void {
	assertExtensionScope(access, extension);
	if (!extension.manifest.storageScopes.includes(storageScope)) {
		throw new ExtensionSecurityError(
			"BRIDGE_DENIED",
			"Extension storage scope is not allow-listed by the manifest",
		);
	}
	if (storageScope === "organization" && !access.organizationId) {
		throw new ExtensionSecurityError(
			"FORBIDDEN",
			"Organization storage requires verified organization scope",
		);
	}
}

export function normalizeExtensionManifest(
	manifest: Partial<ExtensionManifest>,
): ExtensionManifest {
	const normalize = (values: readonly string[] | undefined, label: string) => {
		const unique = [...new Set(values ?? [])];
		if (unique.length > 32) {
			throw new ExtensionSecurityError("PAYLOAD_TOO_LARGE", `${label} contains too many entries`);
		}
		for (const value of unique) assertName(value, label);
		return Object.freeze(unique);
	};
	const storageScopes = [...new Set(manifest.storageScopes ?? [])] as ExtensionStorageScope[];
	if (storageScopes.some((value) => value !== "user" && value !== "organization")) {
		throw new ExtensionSecurityError("UNSAFE_CONTENT", "Extension storage scope is not supported");
	}
	return Object.freeze({
		slots: normalize(manifest.slots, "slots"),
		requestedActions: normalize(manifest.requestedActions, "requestedActions"),
		requestedCommands: normalize(manifest.requestedCommands, "requestedCommands"),
		storageScopes: Object.freeze(storageScopes),
	});
}
