import type { ActionCaller } from "@agent-native/core/action";

export type InvocationStatus = "running" | "completed" | "failed";
export type InvocationCaller = ActionCaller | "extension";

export interface InvocationRecord {
	id: string;
	scopeKey: string;
	actionName: string;
	idempotencyKey: string;
	actorId: string;
	requestFingerprint: string;
	caller: InvocationCaller;
	status: InvocationStatus;
	result?: unknown;
	errorCode?: string;
	errorMessage?: string;
	createdAt: number;
	updatedAt: number;
}

export type ClaimInvocationResult =
	| { outcome: "claimed"; invocation: InvocationRecord }
	| { outcome: "in_flight"; invocation: InvocationRecord }
	| { outcome: "replay"; invocation: InvocationRecord }
	| { outcome: "conflict"; invocation: InvocationRecord };

export interface ClaimInvocationInput {
	scopeKey: string;
	actionName: string;
	idempotencyKey: string;
	actorId: string;
	requestFingerprint: string;
	caller: InvocationCaller;
}

export type InvocationSettlement =
	| { outcome: "completed"; result: unknown }
	| { outcome: "failed"; errorCode: string; errorMessage: string };

export interface SettleInvocationInput {
	scopeKey: string;
	invocationId: string;
	settlement: InvocationSettlement;
}

export interface InvocationReader {
	getInvocation(input: {
		scopeKey: string;
		invocationId: string;
	}): Promise<InvocationRecord | null>;
}

export interface InvocationWriter {
	claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult>;
	completeInvocation(input: {
		scopeKey: string;
		invocationId: string;
		result: unknown;
	}): Promise<InvocationRecord>;
	failInvocation(input: {
		scopeKey: string;
		invocationId: string;
		errorCode: string;
		errorMessage: string;
	}): Promise<InvocationRecord>;
}

export type InvocationPersistence = InvocationReader & InvocationWriter;

/**
 * Adapter capability that settles either terminal outcome through one atomic
 * semantic operation. The split completion helpers remain part of the base
 * port for existing Agent-Native action consumers.
 */
export interface AtomicInvocationWriter extends InvocationWriter {
	settleInvocation(input: SettleInvocationInput): Promise<InvocationRecord>;
}

export type AtomicInvocationPersistence = InvocationReader & AtomicInvocationWriter;
