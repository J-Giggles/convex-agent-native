const SECRET_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|raw[-_]?body|email[-_]?body|ocr|account[-_]?number|routing[-_]?number|card[-_]?number|pan|iban|swift|connection[-_]?string)/i;
const SENSITIVE_TEXT =
	/(?:bearer\s+[a-z0-9._~+\/-]+|basic\s+[a-z0-9+/=]+|(?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*\S+|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+|\b\d{8,19}\b)/gi;
const MAX_STRING_CHARS = 4_096;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const DURABLE_PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DURABLE_MARKER = "$agentNative";
const IDENTIFIER_FIELD = /(?:^|[_-])(?:id|ids)$/i;
const CAMEL_IDENTIFIER_FIELD = /Ids?$/;
const DIGEST_FIELD = /(?:digest|hash)$/i;

export interface ActionReplayIdentifier {
	readonly $agentNative: "opaque-id";
	readonly purpose: string;
	readonly value: string;
}

export interface ActionReplayDigest {
	readonly $agentNative: "sha256";
	readonly purpose: string;
	readonly value: string;
}

export function actionReplayIdentifier(purpose: string, value: string): ActionReplayIdentifier {
	assertPurpose(purpose);
	if (
		!OPAQUE_IDENTIFIER.test(value) ||
		/\b\d{8,19}\b/.test(value) ||
		containsReversibleTextEncoding(value)
	) {
		unsafe();
	}
	return Object.freeze({ $agentNative: "opaque-id", purpose, value });
}

export function actionReplayDigest(purpose: string, value: string): ActionReplayDigest {
	assertPurpose(purpose);
	if (!SHA256_DIGEST.test(value)) unsafe();
	return Object.freeze({ $agentNative: "sha256", purpose, value });
}

function assertPurpose(purpose: string): void {
	if (!DURABLE_PURPOSE.test(purpose) || SECRET_KEY.test(purpose)) unsafe();
}

function containsReversibleTextEncoding(value: string): boolean {
	if (/%[0-9a-f]{2}/i.test(value)) return true;
	const candidates = [value, ...value.split(/[:._-]/)].filter((part) => part.length >= 8);
	return candidates.some((candidate) => decodesToReadableText(candidate));
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
		const decoded = atob(padded);
		return isReadableUtf8(Uint8Array.from(decoded, (character) => character.charCodeAt(0)));
	} catch {
		return false;
	}
}

function isReadableUtf8(bytes: Uint8Array): boolean {
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return decoded.length >= 4 && /^[\x20-\x7e]+$/.test(decoded) && /[A-Za-z]{3}/.test(decoded);
	} catch {
		return false;
	}
}

function assertDurableString(value: Record<string, unknown>): void {
	const keys = Object.keys(value).sort();
	if (
		keys.length !== 3 ||
		keys[0] !== DURABLE_MARKER ||
		keys[1] !== "purpose" ||
		keys[2] !== "value" ||
		typeof value.purpose !== "string" ||
		typeof value.value !== "string"
	) {
		unsafe();
	}
	if (value[DURABLE_MARKER] === "opaque-id") {
		actionReplayIdentifier(value.purpose, value.value);
		return;
	}
	if (value[DURABLE_MARKER] === "sha256") {
		actionReplayDigest(value.purpose, value.value);
		return;
	}
	unsafe();
}

export function sanitizePersistedValue(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return "[truncated]";
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const bounded =
			value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS)}…[truncated]`;
		return bounded.replace(SENSITIVE_TEXT, "[redacted]");
	}
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizePersistedValue(item, depth + 1));
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
			result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizePersistedValue(entry, depth + 1);
		}
		return result;
	}
	return String(value);
}

export function sanitizeErrorMessage(error: unknown): string {
	return error instanceof Error && error.name === "AgentNativeConvexError"
		? "The action request was refused"
		: "Action execution failed";
}

export function assertSafePersistedValue(value: unknown, depth = 0): void {
	assertSafePersistedValueAtPurpose(value, depth);
}

function assertSafePersistedValueAtPurpose(value: unknown, depth: number, purpose?: string): void {
	if (depth > MAX_DEPTH) unsafe();
	if (value === null || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value) && Math.abs(value) >= 10_000_000) unsafe();
		return;
	}
	if (typeof value === "string") {
		SENSITIVE_TEXT.lastIndex = 0;
		if (value.length > MAX_STRING_CHARS || SENSITIVE_TEXT.test(value)) unsafe();
		if (purpose !== undefined && isIdentifierField(purpose)) {
			actionReplayIdentifier(normalizePurpose(purpose), value);
			return;
		}
		if (purpose !== undefined && DIGEST_FIELD.test(purpose)) {
			actionReplayDigest(normalizePurpose(purpose), value);
			return;
		}
		// Arbitrary strings are reversible content. Persist only a validated,
		// purpose-typed representation or an explicitly named identifier/digest field.
		unsafe();
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS) unsafe();
		for (const item of value) assertSafePersistedValueAtPurpose(item, depth + 1, purpose);
		return;
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) unsafe();
		const record = value as Record<string, unknown>;
		if (DURABLE_MARKER in record) {
			assertDurableString(record);
			return;
		}
		const entries = Object.entries(value);
		if (entries.length > MAX_OBJECT_KEYS) unsafe();
		for (const [key, entry] of entries) {
			if (SECRET_KEY.test(key)) unsafe();
			assertSafePersistedValueAtPurpose(entry, depth + 1, key);
		}
		return;
	}
	unsafe();
}

function isIdentifierField(value: string): boolean {
	return IDENTIFIER_FIELD.test(value) || CAMEL_IDENTIFIER_FIELD.test(value);
}

function normalizePurpose(value: string): string {
	const normalized = value
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	if (!DURABLE_PURPOSE.test(normalized)) unsafe();
	return normalized;
}

function unsafe(): never {
	const error = new Error("Replay projection contains disallowed data");
	error.name = "UnsafePersistedResultError";
	throw error;
}
