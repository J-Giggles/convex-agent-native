import {
	AutomationStateError,
	isResolvedAutomationAccess,
	type AutomationDraft,
	type AutomationJobRecord,
	type AutomationRecord,
	type AutomationTrigger,
	type ResolvedAutomationAccess,
} from "./types.js";

const AUTOMATION_ID = /^[a-z][a-z0-9-]{0,95}$/;
const ACTION_NAME = /^[a-z][a-z0-9-]{0,95}$/;
const EVENT_NAME = /^[a-z][a-z0-9._:-]{0,127}$/;
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const MAX_STRING_CHARS = 8_192;
const SECRET_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const SECRET_VALUE =
	/(?:\$\{(?:keys|automationSecret)\.[^}]+\}|authorization\s*:|bearer\s+[A-Za-z0-9._~+\/-]{6,}|(?:token|password|secret)\s*[=:]\s*\S+)/i;
const DURABLE_MARKER = "$agentNative";
const DURABLE_PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const FAILURE_MESSAGE = /^[a-z][a-z0-9._:-]{0,255}$/;
const IDENTIFIER_FIELD = /(?:^|[_-])(?:id|ids)$/i;
const CAMEL_IDENTIFIER_FIELD = /Ids?$/;
const DIGEST_FIELD = /(?:digest|hash)$/i;
const DATE_FIELD = /date$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;

export interface AutomationPayloadIdentifier {
	readonly $agentNative: "opaque-id";
	readonly purpose: string;
	readonly value: string;
}

export interface AutomationPayloadDigest {
	readonly $agentNative: "sha256";
	readonly purpose: string;
	readonly value: string;
}

export function automationPayloadIdentifier(
	purpose: string,
	value: string,
): AutomationPayloadIdentifier {
	assertDurablePurpose(purpose);
	if (
		!OPAQUE_IDENTIFIER.test(value) ||
		/\b\d{8,19}\b/.test(value) ||
		containsReversibleTextEncoding(value)
	) {
		unsafePayload();
	}
	return Object.freeze({ $agentNative: "opaque-id", purpose, value });
}

export function automationPayloadDigest(purpose: string, value: string): AutomationPayloadDigest {
	assertDurablePurpose(purpose);
	if (!SHA256_DIGEST.test(value)) unsafePayload();
	return Object.freeze({ $agentNative: "sha256", purpose, value });
}

function assertDurablePurpose(purpose: string): void {
	if (!DURABLE_PURPOSE.test(purpose) || SECRET_KEY.test(purpose)) unsafePayload();
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

function unsafePayload(): never {
	throw new AutomationStateError(
		"UNSAFE_PAYLOAD",
		"Automation payload contains data without an approved durable representation",
	);
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
		unsafePayload();
	}
	if (value[DURABLE_MARKER] === "opaque-id") {
		automationPayloadIdentifier(value.purpose, value.value);
		return;
	}
	if (value[DURABLE_MARKER] === "sha256") {
		automationPayloadDigest(value.purpose, value.value);
		return;
	}
	unsafePayload();
}

function isFailureMetadata(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	return (
		entries.length > 0 &&
		entries.every(
			([key, item]) => (key === "errorCode" || key === "errorMessage") && typeof item === "string",
		)
	);
}

function assertFailureMetadata(value: Record<string, string>): void {
	if (
		(value.errorCode !== undefined && !FAILURE_CODE.test(value.errorCode)) ||
		(value.errorMessage !== undefined &&
			(!FAILURE_MESSAGE.test(value.errorMessage) || SECRET_VALUE.test(value.errorMessage)))
	) {
		unsafePayload();
	}
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertPayloadValue(value: unknown, depth = 0, purpose?: string): void {
	if (depth > MAX_DEPTH) {
		throw new AutomationStateError("UNSAFE_PAYLOAD", "Automation payload nesting is too deep");
	}
	if (typeof value === "string") {
		if (value.length > MAX_STRING_CHARS || SECRET_VALUE.test(value) || /\b\d{8,19}\b/.test(value)) {
			unsafePayload();
		}
		if (purpose !== undefined && isIdentifierField(purpose)) {
			automationPayloadIdentifier(normalizeDurablePurpose(purpose), value);
			return;
		}
		if (purpose !== undefined && DIGEST_FIELD.test(purpose)) {
			automationPayloadDigest(normalizeDurablePurpose(purpose), value);
			return;
		}
		if (purpose !== undefined && DATE_FIELD.test(purpose) && ISO_DATE.test(value)) return;
		unsafePayload();
	}
	if (value === null || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value) && Math.abs(value) >= 10_000_000) {
			throw new AutomationStateError(
				"UNSAFE_PAYLOAD",
				"Automation payload contains a financial-identifier-shaped integer",
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ITEMS) {
			throw new AutomationStateError("PAYLOAD_TOO_LARGE", "Automation payload has too many items");
		}
		for (const item of value) assertPayloadValue(item, depth + 1, purpose);
		return;
	}
	if (value && typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new AutomationStateError(
				"UNSAFE_PAYLOAD",
				"Automation payload must use plain JSON objects",
			);
		}
		const entries = Object.entries(value);
		const record = value as Record<string, unknown>;
		if (DURABLE_MARKER in record) {
			assertDurableString(record);
			return;
		}
		if (entries.length > MAX_ITEMS) {
			throw new AutomationStateError("PAYLOAD_TOO_LARGE", "Automation payload has too many fields");
		}
		for (const [key, item] of entries) {
			if (SECRET_KEY.test(key)) {
				throw new AutomationStateError(
					"UNSAFE_PAYLOAD",
					"Automation payload contains a secret-shaped field",
				);
			}
			assertPayloadValue(item, depth + 1, key);
		}
		return;
	}
	throw new AutomationStateError(
		"UNSAFE_PAYLOAD",
		"Automation payload must be finite JSON-compatible data",
	);
}

function isIdentifierField(value: string): boolean {
	return IDENTIFIER_FIELD.test(value) || CAMEL_IDENTIFIER_FIELD.test(value);
}

function normalizeDurablePurpose(value: string): string {
	const normalized = value
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	if (!DURABLE_PURPOSE.test(normalized)) unsafePayload();
	return normalized;
}

export function assertSafeAutomationPayload(value: unknown): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new AutomationStateError("UNSAFE_PAYLOAD", "Automation payload must be serializable", {
			cause: error,
		});
	}
	if (encoded === undefined) {
		throw new AutomationStateError("UNSAFE_PAYLOAD", "Automation payload must be JSON-compatible");
	}
	if (bytes(encoded) > MAX_JOB_PAYLOAD_BYTES) {
		throw new AutomationStateError("PAYLOAD_TOO_LARGE", "Automation payload is too large");
	}
	if (isFailureMetadata(value)) {
		assertFailureMetadata(value);
		return;
	}
	assertPayloadValue(value);
}

function normalizeTrigger(trigger: AutomationTrigger): AutomationTrigger {
	if (trigger.kind === "event") {
		const event = trigger.event.trim();
		if (!EVENT_NAME.test(event)) {
			throw new AutomationStateError("INVALID_AUTOMATION", "Automation event name is invalid");
		}
		return Object.freeze({ kind: "event", event });
	}
	const schedule = trigger.schedule.trim().replace(/\s+/g, " ");
	if (schedule.split(" ").length !== 5 || schedule.length > 128) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Automation schedule must be a bounded five-field cron expression",
		);
	}
	if (!Number.isFinite(trigger.nextRunAt) || trigger.nextRunAt < 0) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Scheduled automation requires a finite next run time",
		);
	}
	return Object.freeze({
		kind: "schedule",
		schedule,
		nextRunAt: trigger.nextRunAt,
	});
}

export function createAutomationDraft(input: AutomationDraft): AutomationDraft {
	const id = input.id.trim();
	const name = input.name.trim();
	const instructions = input.instructions.trim();
	if (!AUTOMATION_ID.test(id)) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Automation ID must use lowercase letters, numbers, and hyphens",
		);
	}
	if (!name || name.length > 160 || !instructions) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Automation requires a bounded name and non-empty instructions",
		);
	}
	if (bytes(instructions) > MAX_INSTRUCTIONS_BYTES || SECRET_VALUE.test(instructions)) {
		throw new AutomationStateError(
			bytes(instructions) > MAX_INSTRUCTIONS_BYTES ? "PAYLOAD_TOO_LARGE" : "UNSAFE_PAYLOAD",
			"Automation instructions are too large or contain secret-shaped data",
		);
	}
	const allowedActions = [...new Set(input.allowedActions)];
	if (allowedActions.length > 64 || allowedActions.some((action) => !ACTION_NAME.test(action))) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Automation action allowlist is invalid or too large",
		);
	}
	if (
		input.expectedRevision !== undefined &&
		(!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
	) {
		throw new AutomationStateError(
			"INVALID_AUTOMATION",
			"Expected revision must be a positive integer",
		);
	}
	return Object.freeze({
		id,
		name,
		instructions,
		trigger: normalizeTrigger(input.trigger),
		enabled: input.enabled,
		allowedActions: Object.freeze(allowedActions),
		...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
	});
}

export function assertAutomationScope(
	access: ResolvedAutomationAccess,
	record: Pick<AutomationRecord, "scopeKey" | "organizationId">,
): void {
	if (!isResolvedAutomationAccess(access)) {
		throw new AutomationStateError(
			"INVALID_SCOPE",
			"Automation access must be resolved by the host",
		);
	}
	if (record.scopeKey !== access.scopeKey) {
		throw new AutomationStateError("FORBIDDEN", "Automation is outside the resolved scope");
	}
	if (
		record.organizationId !== undefined &&
		(!access.organizationId || record.organizationId !== access.organizationId)
	) {
		throw new AutomationStateError(
			"FORBIDDEN",
			"Automation organization scope does not match the caller",
		);
	}
}

export function assertAutomationMutationAccess(access: ResolvedAutomationAccess): void {
	if (!isResolvedAutomationAccess(access)) {
		throw new AutomationStateError(
			"INVALID_SCOPE",
			"Automation access must be resolved by the host",
		);
	}
	if (access.role === "viewer" || access.role === "runner") {
		throw new AutomationStateError(
			"FORBIDDEN",
			"Automation definitions require editor, admin, or owner access",
		);
	}
}

export function assertAutomationRunAccess(
	access: ResolvedAutomationAccess,
	automation: AutomationRecord,
): void {
	assertAutomationScope(access, automation);
	if (access.role === "viewer") {
		throw new AutomationStateError("FORBIDDEN", "Viewer access cannot run automations");
	}
	if (!automation.enabled) {
		throw new AutomationStateError("INVALID_AUTOMATION", "Disabled automation cannot claim a job");
	}
}

export function assertRunningJob(access: ResolvedAutomationAccess, job: AutomationJobRecord): void {
	if (!isResolvedAutomationAccess(access) || job.scopeKey !== access.scopeKey) {
		throw new AutomationStateError("FORBIDDEN", "Automation job is outside the resolved scope");
	}
	if (job.status !== "running" || !job.leaseToken || !Number.isFinite(job.leaseExpiresAt)) {
		throw new AutomationStateError(
			"INVALID_TRANSITION",
			"Only a leased running job can transition",
		);
	}
}

export function normalizeLeaseDuration(value: number): number {
	if (!Number.isFinite(value) || value < 5_000 || value > 15 * 60_000) {
		throw new AutomationStateError(
			"INVALID_TRANSITION",
			"Job lease duration must be between 5 seconds and 15 minutes",
		);
	}
	return Math.floor(value);
}
