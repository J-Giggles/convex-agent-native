import type { InvocationCaller } from "./invocations.js";

export type InvocationAuditEventKind = "claimed" | "completed" | "failed";

/**
 * Allowlisted lifecycle projection. Inputs, results, idempotency keys, error
 * messages, protocol bodies, and arbitrary metadata intentionally cannot be
 * represented by this contract.
 */
export interface InvocationAuditEvent {
	id: string;
	invocationId: string;
	actionName: string;
	caller: InvocationCaller;
	event: InvocationAuditEventKind;
	errorCode?: string;
	createdAt: number;
}

export interface InvocationAuditReader {
	listInvocationAuditEvents(input: {
		scopeKey: string;
		invocationId: string;
	}): Promise<readonly InvocationAuditEvent[]>;
}
