const MAX_BYTES = 32 * 1024;
const MAX_ITEMS = 64;
const MAX_TEXT_CHARS = 4_096;
const MAX_DEPTH = 8;
const SECRET_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const SECRET_VALUE =
	/(?:\$\{(?:keys|automationSecret)\.[^}]+\}|authorization\s*:|bearer\s+[A-Za-z0-9._~+\/-]{6,}|(?:token|password|secret)\s*[=:]\s*\S+)/i;
const DURABLE_PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_FIELD = /(?:^|[_-])(?:id|ids)$/i;
const CAMEL_IDENTIFIER_FIELD = /Ids?$/;
const DIGEST_FIELD = /(?:digest|hash)$/i;
const FINANCIAL_IDENTIFIER = /\b\d{8,19}\b/;
const DURABLE_MARKER = "$agentNative";

export type DurableContentFailureCode = "UNSAFE_CONTENT" | "PAYLOAD_TOO_LARGE";

export class DurableContentPolicyError extends Error {
	constructor(
		readonly code: DurableContentFailureCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "DurableContentPolicyError";
	}
}

export interface PurposeTypedIdentifier {
	readonly $agentNative: "opaque-id";
	readonly purpose: string;
	readonly value: string;
}

export interface PurposeTypedDigest {
	readonly $agentNative: "sha256";
	readonly purpose: string;
	readonly value: string;
}

function unsafe(message = "Durable strings require a purpose-typed identifier or digest"): never {
	throw new DurableContentPolicyError("UNSAFE_CONTENT", message);
}

function normalizePurpose(value: string): string {
	const purpose = value
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	if (!DURABLE_PURPOSE.test(purpose) || SECRET_KEY.test(purpose))
		unsafe("Durable purpose is invalid");
	return purpose;
}

function isReadableUtf8(bytes: Uint8Array): boolean {
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return decoded.length >= 4 && /^[\x20-\x7e]+$/.test(decoded) && /[A-Za-z]{3}/.test(decoded);
	} catch {
		return false;
	}
}

function decodesToReadableText(value: string): boolean {
	if (/^(?:[0-9a-f]{2}){4,}$/i.test(value)) {
		const bytes = new Uint8Array(value.length / 2);
		for (let index = 0; index < value.length; index += 2) {
			bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
		}
		if (isReadableUtf8(bytes)) return true;
	}
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return isReadableUtf8(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
	} catch {
		return false;
	}
}

function containsReversibleTextEncoding(value: string): boolean {
	if (/%[0-9a-f]{2}/i.test(value)) return true;
	return [value, ...value.split(/[:._-]/)]
		.filter((part) => part.length >= 8)
		.some(decodesToReadableText);
}

export function purposeTypedIdentifier(purpose: string, value: string): PurposeTypedIdentifier {
	normalizePurpose(purpose);
	if (
		!OPAQUE_IDENTIFIER.test(value) ||
		FINANCIAL_IDENTIFIER.test(value) ||
		containsReversibleTextEncoding(value)
	) {
		unsafe("Durable identifier is unsafe");
	}
	return Object.freeze({ $agentNative: "opaque-id", purpose, value });
}

export function purposeTypedDigest(purpose: string, value: string): PurposeTypedDigest {
	normalizePurpose(purpose);
	if (!SHA256_DIGEST.test(value)) unsafe("Durable digest is invalid");
	return Object.freeze({ $agentNative: "sha256", purpose, value });
}

function isIdentifierField(value: string): boolean {
	return IDENTIFIER_FIELD.test(value) || CAMEL_IDENTIFIER_FIELD.test(value);
}

function assertMarker(value: Record<string, unknown>, outerPurpose?: string): void {
	const keys = Object.keys(value).sort();
	if (
		keys.length !== 3 ||
		keys[0] !== DURABLE_MARKER ||
		keys[1] !== "purpose" ||
		keys[2] !== "value" ||
		typeof value.purpose !== "string" ||
		typeof value.value !== "string"
	) {
		unsafe("Durable marker is invalid");
	}
	if (value[DURABLE_MARKER] === "opaque-id") {
		if (outerPurpose !== undefined && DIGEST_FIELD.test(outerPurpose)) {
			unsafe("Digest fields require a digest marker");
		}
		purposeTypedIdentifier(value.purpose, value.value);
		return;
	}
	if (value[DURABLE_MARKER] === "sha256") {
		if (outerPurpose !== undefined && isIdentifierField(outerPurpose)) {
			unsafe("Identifier fields require an identifier marker");
		}
		purposeTypedDigest(value.purpose, value.value);
		return;
	}
	unsafe("Durable marker is invalid");
}

function assertValue(value: unknown, depth = 0, purpose?: string): void {
	if (depth > MAX_DEPTH) unsafe("Durable content nesting is too deep");
	if (typeof value === "string") {
		if (value.length > MAX_TEXT_CHARS || SECRET_VALUE.test(value)) unsafe("Durable text is unsafe");
		if (purpose !== undefined && isIdentifierField(purpose)) {
			purposeTypedIdentifier(normalizePurpose(purpose), value);
			return;
		}
		if (purpose !== undefined && DIGEST_FIELD.test(purpose)) {
			purposeTypedDigest(normalizePurpose(purpose), value);
			return;
		}
		unsafe();
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ITEMS) {
			throw new DurableContentPolicyError(
				"PAYLOAD_TOO_LARGE",
				"Durable content has too many items",
			);
		}
		for (const item of value) assertValue(item, depth + 1, purpose);
		return;
	}
	if (value && typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			unsafe("Durable content must use plain JSON objects");
		}
		const record = value as Record<string, unknown>;
		if (DURABLE_MARKER in record) {
			assertMarker(record, purpose);
			return;
		}
		if (purpose !== undefined && (isIdentifierField(purpose) || DIGEST_FIELD.test(purpose))) {
			unsafe("Purpose-typed fields cannot contain untyped nested objects");
		}
		const entries = Object.entries(record);
		if (entries.length > MAX_ITEMS) {
			throw new DurableContentPolicyError(
				"PAYLOAD_TOO_LARGE",
				"Durable content has too many fields",
			);
		}
		for (const [key, item] of entries) {
			if (SECRET_KEY.test(key)) unsafe("Durable content contains a secret-shaped field");
			assertValue(item, depth + 1, key);
		}
		return;
	}
	if (purpose !== undefined && (isIdentifierField(purpose) || DIGEST_FIELD.test(purpose))) {
		unsafe("Purpose-typed fields require an identifier or digest");
	}
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value) && Math.abs(value) >= 10_000_000) {
			unsafe("Durable content contains an identifier-shaped integer");
		}
		return;
	}
	unsafe("Durable content must be finite JSON data");
}

/** Canonical pure policy shared by package and Convex component boundaries. */
export function assertPurposeTypedDurableContent(value: unknown): void {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (cause) {
		throw new DurableContentPolicyError("UNSAFE_CONTENT", "Durable content must be serializable", {
			cause,
		});
	}
	if (encoded === undefined) unsafe("Durable content must be JSON-compatible");
	if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) {
		throw new DurableContentPolicyError("PAYLOAD_TOO_LARGE", "Durable content is too large");
	}
	assertValue(value);
}
