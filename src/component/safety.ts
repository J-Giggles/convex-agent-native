const MAX_SCOPE_KEY_CHARS = 256;
const MAX_ACTION_NAME_CHARS = 96;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const MAX_ACTOR_ID_CHARS = 256;
const MAX_ERROR_CODE_CHARS = 96;
const MAX_ERROR_MESSAGE_CHARS = 1_024;
const MAX_RESULT_JSON_CHARS = 32_768;
const MAX_RESULT_STRING_CHARS = 4_096;
const MAX_RESULT_ARRAY_ITEMS = 100;
const MAX_RESULT_OBJECT_KEYS = 100;
const MAX_RESULT_DEPTH = 8;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const SECRET_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|raw[-_]?body|email[-_]?body|ocr|account[-_]?number|routing[-_]?number|card[-_]?number|pan|iban|swift|connection[-_]?string)/i;
const SENSITIVE_TEXT =
	/(?:bearer\s+[a-z0-9._~+\/-]+|basic\s+[a-z0-9+/=]+|(?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*\S+|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+|\b\d{8,19}\b)/i;
const DURABLE_STRING_ATOM = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function assertBoundedIdentifier(value: string, name: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new Error(`${name} must be a bounded non-empty identifier`);
	}
	return normalized;
}

export function assertScopeKey(value: string): string {
	return assertBoundedIdentifier(value, "scopeKey", MAX_SCOPE_KEY_CHARS);
}

export function assertActionName(value: string): string {
	return assertBoundedIdentifier(value, "actionName", MAX_ACTION_NAME_CHARS);
}

export function assertIdempotencyKey(value: string): string {
	return assertBoundedIdentifier(value, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
}

export function assertActorId(value: string): string {
	return assertBoundedIdentifier(value, "actorId", MAX_ACTOR_ID_CHARS);
}

export function assertRequestFingerprint(value: string): string {
	const normalized = value.trim();
	if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
		throw new Error("requestFingerprint must be a SHA-256 digest");
	}
	return normalized;
}

export function assertErrorCode(value: string): string {
	const normalized = assertBoundedIdentifier(value, "errorCode", MAX_ERROR_CODE_CHARS);
	if (!ERROR_CODE.test(normalized)) {
		throw new Error("errorCode must use the stable error-code format");
	}
	return normalized;
}

function assertResult(value: unknown, depth: number): void {
	if (depth > MAX_RESULT_DEPTH) throw new Error("Invocation result is nested too deeply");
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		if (
			typeof value === "number" &&
			(!Number.isFinite(value) || (Number.isInteger(value) && Math.abs(value) >= 10_000_000))
		) {
			throw new Error("Invocation result must contain finite numbers");
		}
		return;
	}
	if (typeof value === "string") {
		if (
			value.length > MAX_RESULT_STRING_CHARS ||
			SENSITIVE_TEXT.test(value) ||
			!DURABLE_STRING_ATOM.test(value)
		) {
			throw new Error("Invocation result contains unsafe or unbounded text");
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_RESULT_ARRAY_ITEMS)
			throw new Error("Invocation result has too many items");
		for (const entry of value) assertResult(entry, depth + 1);
		return;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length > MAX_RESULT_OBJECT_KEYS)
			throw new Error("Invocation result has too many fields");
		for (const [key, entry] of entries) {
			if (SECRET_KEY.test(key)) throw new Error("Invocation result contains an unsafe field");
			assertResult(entry, depth + 1);
		}
		return;
	}
	throw new Error("Invocation result must be finite JSON-compatible data");
}

export function sanitizeResult(value: unknown): unknown {
	assertResult(value, 0);
	const serialized = JSON.stringify(value);
	if (serialized.length > MAX_RESULT_JSON_CHARS) {
		throw new Error("Invocation result exceeds the safe persistence limit");
	}
	return value;
}

export function sanitizeErrorMessage(value: string): string {
	void value;
	return "Action execution failed";
}
