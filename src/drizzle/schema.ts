import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { InvocationAuditEventKind } from "../persistence/audit.js";
import type { InvocationCaller, InvocationStatus } from "../persistence/invocations.js";

export const drizzleInvocations = sqliteTable(
	"agent_native_invocations",
	{
		id: text("id").primaryKey(),
		scopeKey: text("scope_key").notNull(),
		actionName: text("action_name").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		actorId: text("actor_id").notNull(),
		requestFingerprint: text("request_fingerprint").notNull(),
		caller: text("caller").$type<InvocationCaller>().notNull(),
		status: text("status").$type<InvocationStatus>().notNull(),
		resultJson: text("result_json"),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("agent_native_invocations_idempotency_unique").on(
			table.scopeKey,
			table.actionName,
			table.idempotencyKey,
		),
		index("agent_native_invocations_scope_id_index").on(table.scopeKey, table.id),
	],
);

export const drizzleInvocationAuditEvents = sqliteTable(
	"agent_native_invocation_audit_events",
	{
		id: text("id").primaryKey(),
		scopeKey: text("scope_key").notNull(),
		invocationId: text("invocation_id").notNull(),
		actionName: text("action_name").notNull(),
		caller: text("caller").$type<InvocationCaller>().notNull(),
		event: text("event").$type<InvocationAuditEventKind>().notNull(),
		errorCode: text("error_code"),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("agent_native_invocation_audit_lifecycle_unique").on(
			table.scopeKey,
			table.invocationId,
			table.event,
		),
		index("agent_native_invocation_audit_scope_invocation_index").on(
			table.scopeKey,
			table.invocationId,
			table.createdAt,
		),
	],
);

export const drizzlePersistenceSchema = {
	invocations: drizzleInvocations,
	invocationAuditEvents: drizzleInvocationAuditEvents,
};

export type DrizzleInvocationRow = typeof drizzleInvocations.$inferSelect;
