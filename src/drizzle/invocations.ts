import { randomUUID } from "node:crypto";

import { AgentNativeConvexError } from "../contracts/error.js";
import { assertSafePersistedValue } from "../action/sanitize.js";
import type {
	InvocationAuditEvent,
	InvocationAuditReader,
	InvocationAuditEventKind,
} from "../persistence/audit.js";
import type { AgentNativePersistence } from "../persistence/index.js";
import type {
	AtomicInvocationPersistence,
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationRecord,
	InvocationSettlement,
	SettleInvocationInput,
} from "../persistence/invocations.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
	drizzleInvocationAuditEvents,
	drizzleInvocations,
	drizzlePersistenceSchema,
	type DrizzleInvocationRow,
} from "./schema.js";

export type DrizzlePersistenceDatabase = BetterSQLite3Database<typeof drizzlePersistenceSchema>;

export interface DrizzleInvocationPersistenceOptions {
	clock?: () => number;
	generateId?: () => string;
}

const MAX_SCOPE_KEY_LENGTH = 256;
const MAX_ACTION_NAME_LENGTH = 96;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_INVOCATION_ID_LENGTH = 512;
const MAX_ACTOR_ID_LENGTH = 256;
const REQUEST_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MAX_ERROR_CODE_LENGTH = 96;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_RESULT_JSON_LENGTH = 32_768;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const ACTION_CALLERS = new Set([
	"tool",
	"http",
	"frontend",
	"cli",
	"mcp",
	"a2a",
	"automation",
	"extension",
]);

function persistenceFailure(message: string, cause?: unknown): AgentNativeConvexError {
	return new AgentNativeConvexError("PERSISTENCE_FAILURE", message, {
		...(cause === undefined ? {} : { cause }),
	});
}

function assertBoundedIdentifier(value: unknown, label: string, maximumLength: number): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (
		!normalized ||
		normalized.length > maximumLength ||
		/[\u0000-\u001f\u007f]/.test(normalized)
	) {
		throw persistenceFailure(`${label} must be a bounded non-empty identifier`);
	}
	return normalized;
}

function encodeResult(value: unknown): string {
	try {
		assertSafePersistedValue(value);
		const encoded = JSON.stringify({ value });
		if (encoded.length > MAX_RESULT_JSON_LENGTH) {
			throw persistenceFailure("Invocation result exceeds the persistence limit");
		}
		return encoded;
	} catch (error) {
		if (error instanceof AgentNativeConvexError) throw error;
		throw persistenceFailure("Invocation result is not persistable", error);
	}
}

function sanitizeErrorMessage(value: string): string {
	void value;
	return "Action execution failed";
}

function decodeResult(encoded: string | null): unknown {
	if (encoded === null) return undefined;
	try {
		return (JSON.parse(encoded) as { value?: unknown }).value;
	} catch (error) {
		throw persistenceFailure("Stored invocation result is invalid", error);
	}
}

function toRecord(row: DrizzleInvocationRow): InvocationRecord {
	return {
		id: row.id,
		scopeKey: row.scopeKey,
		actionName: row.actionName,
		idempotencyKey: row.idempotencyKey,
		actorId: row.actorId,
		requestFingerprint: row.requestFingerprint,
		caller: row.caller,
		status: row.status,
		...(row.resultJson === null ? {} : { result: decodeResult(row.resultJson) }),
		...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
		...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function sameTerminalOutcome(
	invocation: InvocationRecord,
	settlement: InvocationSettlement,
): boolean {
	if (settlement.outcome === "completed") {
		return (
			invocation.status === "completed" &&
			JSON.stringify(invocation.result) === JSON.stringify(settlement.result)
		);
	}
	return invocation.status === "failed" && invocation.errorCode === settlement.errorCode;
}

function existingClaimResult(row: DrizzleInvocationRow): ClaimInvocationResult {
	const invocation = toRecord(row);
	return invocation.status === "running"
		? { outcome: "in_flight", invocation }
		: { outcome: "replay", invocation };
}

function existingClaimResultFor(
	row: DrizzleInvocationRow,
	actorId: string,
	requestFingerprint: string,
	caller: ClaimInvocationInput["caller"],
): ClaimInvocationResult {
	if (
		row.actorId !== actorId ||
		row.requestFingerprint !== requestFingerprint ||
		row.caller !== caller
	) {
		return { outcome: "conflict", invocation: toRecord(row) };
	}
	return existingClaimResult(row);
}

function auditId(invocationId: string, event: InvocationAuditEventKind): string {
	return `${invocationId}:${event}`;
}

function insertAuditEvent(
	transaction: Parameters<Parameters<DrizzlePersistenceDatabase["transaction"]>[0]>[0],
	invocation: DrizzleInvocationRow,
	event: InvocationAuditEventKind,
): void {
	transaction
		.insert(drizzleInvocationAuditEvents)
		.values({
			id: auditId(invocation.id, event),
			scopeKey: invocation.scopeKey,
			invocationId: invocation.id,
			actionName: invocation.actionName,
			caller: invocation.caller,
			event,
			...(event === "failed" && invocation.errorCode !== null
				? { errorCode: invocation.errorCode }
				: {}),
			createdAt: invocation.updatedAt,
		})
		.onConflictDoNothing({
			target: [
				drizzleInvocationAuditEvents.scopeKey,
				drizzleInvocationAuditEvents.invocationId,
				drizzleInvocationAuditEvents.event,
			],
		})
		.run();
}

/**
 * Creates the SQLite objects used by the reference adapter. Applications may
 * instead manage the equivalent schema with their normal migration tool.
 */
export function createDrizzlePersistenceSchema(db: DrizzlePersistenceDatabase): void {
	db.run(sql`
    CREATE TABLE IF NOT EXISTS agent_native_invocations (
      id TEXT PRIMARY KEY NOT NULL,
      scope_key TEXT NOT NULL,
      action_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      caller TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
	db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_native_invocations_idempotency_unique
      ON agent_native_invocations (scope_key, action_name, idempotency_key)
  `);
	db.run(sql`
    CREATE INDEX IF NOT EXISTS agent_native_invocations_scope_id_index
      ON agent_native_invocations (scope_key, id)
  `);
	db.run(sql`
    CREATE TABLE IF NOT EXISTS agent_native_invocation_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      scope_key TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      action_name TEXT NOT NULL,
      caller TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('claimed', 'completed', 'failed')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (invocation_id) REFERENCES agent_native_invocations(id)
    )
  `);
	db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_native_invocation_audit_lifecycle_unique
      ON agent_native_invocation_audit_events (scope_key, invocation_id, event)
  `);
	db.run(sql`
    CREATE INDEX IF NOT EXISTS agent_native_invocation_audit_scope_invocation_index
      ON agent_native_invocation_audit_events (scope_key, invocation_id, created_at)
  `);
}

export function createDrizzleInvocationPersistence(
	db: DrizzlePersistenceDatabase,
	options: DrizzleInvocationPersistenceOptions = {},
): AtomicInvocationPersistence {
	const clock = options.clock ?? Date.now;
	const generateId = options.generateId ?? randomUUID;

	async function getInvocation(input: {
		scopeKey: string;
		invocationId: string;
	}): Promise<InvocationRecord | null> {
		const scopeKey = assertBoundedIdentifier(input.scopeKey, "scopeKey", MAX_SCOPE_KEY_LENGTH);
		const invocationId = assertBoundedIdentifier(
			input.invocationId,
			"invocationId",
			MAX_INVOCATION_ID_LENGTH,
		);
		try {
			const row = db
				.select()
				.from(drizzleInvocations)
				.where(
					and(eq(drizzleInvocations.scopeKey, scopeKey), eq(drizzleInvocations.id, invocationId)),
				)
				.get();
			return row === undefined ? null : toRecord(row);
		} catch (error) {
			if (error instanceof AgentNativeConvexError) throw error;
			throw persistenceFailure("Unable to read invocation", error);
		}
	}

	async function claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		const scopeKey = assertBoundedIdentifier(input.scopeKey, "scopeKey", MAX_SCOPE_KEY_LENGTH);
		const actionName = assertBoundedIdentifier(
			input.actionName,
			"actionName",
			MAX_ACTION_NAME_LENGTH,
		);
		const idempotencyKey = assertBoundedIdentifier(
			input.idempotencyKey,
			"idempotencyKey",
			MAX_IDEMPOTENCY_KEY_LENGTH,
		);
		const actorId = assertBoundedIdentifier(input.actorId, "actorId", MAX_ACTOR_ID_LENGTH);
		const requestFingerprint =
			typeof input.requestFingerprint === "string" ? input.requestFingerprint.trim() : "";
		if (!REQUEST_FINGERPRINT.test(requestFingerprint)) {
			throw persistenceFailure("requestFingerprint must be a SHA-256 digest");
		}
		if (!ACTION_CALLERS.has(input.caller)) {
			throw persistenceFailure("caller is not an official Agent-Native caller");
		}
		try {
			return db.transaction((transaction) => {
				const now = clock();
				const id = generateId();
				const invocationId = assertBoundedIdentifier(
					id,
					"generated invocation id",
					MAX_INVOCATION_ID_LENGTH,
				);
				if (!Number.isSafeInteger(now) || now < 0) {
					throw persistenceFailure("clock must return a non-negative safe integer");
				}
				const inserted = transaction
					.insert(drizzleInvocations)
					.values({
						id: invocationId,
						scopeKey,
						actionName,
						idempotencyKey,
						actorId,
						requestFingerprint,
						caller: input.caller,
						status: "running",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing({
						target: [
							drizzleInvocations.scopeKey,
							drizzleInvocations.actionName,
							drizzleInvocations.idempotencyKey,
						],
					})
					.returning()
					.get();
				if (inserted !== undefined) {
					insertAuditEvent(transaction, inserted, "claimed");
					return { outcome: "claimed" as const, invocation: toRecord(inserted) };
				}
				const existing = transaction
					.select()
					.from(drizzleInvocations)
					.where(
						and(
							eq(drizzleInvocations.scopeKey, scopeKey),
							eq(drizzleInvocations.actionName, actionName),
							eq(drizzleInvocations.idempotencyKey, idempotencyKey),
						),
					)
					.get();
				if (existing === undefined) {
					throw persistenceFailure("Invocation claim conflict could not be resolved");
				}
				return existingClaimResultFor(existing, actorId, requestFingerprint, input.caller);
			});
		} catch (error) {
			if (error instanceof AgentNativeConvexError) throw error;
			throw persistenceFailure("Unable to claim invocation", error);
		}
	}

	async function settleInvocation(input: SettleInvocationInput): Promise<InvocationRecord> {
		const scopeKey = assertBoundedIdentifier(input.scopeKey, "scopeKey", MAX_SCOPE_KEY_LENGTH);
		const invocationId = assertBoundedIdentifier(
			input.invocationId,
			"invocationId",
			MAX_INVOCATION_ID_LENGTH,
		);
		let errorCode: string | undefined;
		let errorMessage: string | undefined;
		if (input.settlement.outcome === "failed") {
			errorCode = assertBoundedIdentifier(
				input.settlement.errorCode,
				"errorCode",
				MAX_ERROR_CODE_LENGTH,
			);
			if (!ERROR_CODE.test(errorCode)) {
				throw persistenceFailure("errorCode must use the stable error-code format");
			}
			errorMessage = sanitizeErrorMessage(input.settlement.errorMessage);
		}
		try {
			return db.transaction((transaction) => {
				const settlement = input.settlement;
				const now = clock();
				if (!Number.isSafeInteger(now) || now < 0) {
					throw persistenceFailure("clock must return a non-negative safe integer");
				}
				const values =
					settlement.outcome === "completed"
						? {
								status: "completed" as const,
								resultJson: encodeResult(settlement.result),
								errorCode: null,
								errorMessage: null,
								updatedAt: now,
							}
						: {
								status: "failed" as const,
								resultJson: null,
								errorCode,
								errorMessage,
								updatedAt: now,
							};
				const updated = transaction
					.update(drizzleInvocations)
					.set(values)
					.where(
						and(
							eq(drizzleInvocations.scopeKey, scopeKey),
							eq(drizzleInvocations.id, invocationId),
							eq(drizzleInvocations.status, "running"),
						),
					)
					.returning()
					.get();
				if (updated !== undefined) {
					insertAuditEvent(transaction, updated, settlement.outcome);
					return toRecord(updated);
				}

				const existing = transaction
					.select()
					.from(drizzleInvocations)
					.where(
						and(eq(drizzleInvocations.scopeKey, scopeKey), eq(drizzleInvocations.id, invocationId)),
					)
					.get();
				if (existing === undefined) {
					throw persistenceFailure("Invocation was not found in the requested scope");
				}
				const invocation = toRecord(existing);
				if (sameTerminalOutcome(invocation, settlement)) return invocation;
				throw persistenceFailure("Invocation is already settled with another outcome");
			});
		} catch (error) {
			if (error instanceof AgentNativeConvexError) throw error;
			throw persistenceFailure("Unable to settle invocation", error);
		}
	}

	return {
		getInvocation,
		claimInvocation,
		settleInvocation,
		completeInvocation: (input) =>
			settleInvocation({
				scopeKey: input.scopeKey,
				invocationId: input.invocationId,
				settlement: { outcome: "completed", result: input.result },
			}),
		failInvocation: (input) =>
			settleInvocation({
				scopeKey: input.scopeKey,
				invocationId: input.invocationId,
				settlement: {
					outcome: "failed",
					errorCode: input.errorCode,
					errorMessage: input.errorMessage,
				},
			}),
	};
}

export function createDrizzleAuditReader(db: DrizzlePersistenceDatabase): InvocationAuditReader {
	return {
		async listInvocationAuditEvents(input): Promise<readonly InvocationAuditEvent[]> {
			const scopeKey = assertBoundedIdentifier(input.scopeKey, "scopeKey", MAX_SCOPE_KEY_LENGTH);
			const invocationId = assertBoundedIdentifier(
				input.invocationId,
				"invocationId",
				MAX_INVOCATION_ID_LENGTH,
			);
			try {
				return db
					.select()
					.from(drizzleInvocationAuditEvents)
					.where(
						and(
							eq(drizzleInvocationAuditEvents.scopeKey, scopeKey),
							eq(drizzleInvocationAuditEvents.invocationId, invocationId),
						),
					)
					.orderBy(
						asc(drizzleInvocationAuditEvents.createdAt),
						asc(drizzleInvocationAuditEvents.id),
					)
					.all()
					.map((row) => ({
						id: row.id,
						invocationId: row.invocationId,
						actionName: row.actionName,
						caller: row.caller,
						event: row.event,
						...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
						createdAt: row.createdAt,
					}));
			} catch (error) {
				if (error instanceof AgentNativeConvexError) throw error;
				throw persistenceFailure("Unable to read invocation audit", error);
			}
		},
	};
}

export function createDrizzlePersistence(
	db: DrizzlePersistenceDatabase,
	options: DrizzleInvocationPersistenceOptions = {},
): AgentNativePersistence {
	return {
		invocations: createDrizzleInvocationPersistence(db, options),
		audit: createDrizzleAuditReader(db),
	};
}
