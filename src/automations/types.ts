const automationAccessBrand: unique symbol = Symbol("agent-native-convex.automation-access");

export type AutomationRole = "owner" | "admin" | "editor" | "viewer" | "runner";

export interface ResolvedAutomationAccess {
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly organizationId?: string;
	readonly role: AutomationRole;
	readonly [automationAccessBrand]: true;
}

export type AutomationStateErrorCode =
	| "INVALID_SCOPE"
	| "FORBIDDEN"
	| "INVALID_AUTOMATION"
	| "IDEMPOTENCY_KEY_REQUIRED"
	| "INVALID_TRANSITION"
	| "PAYLOAD_TOO_LARGE"
	| "UNSAFE_PAYLOAD"
	| "PERSISTENCE_FAILURE";

export class AutomationStateError extends Error {
	constructor(
		readonly code: AutomationStateErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AutomationStateError";
	}
}

function identifier(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) {
		throw new AutomationStateError(
			"INVALID_SCOPE",
			`${label} must be a bounded non-empty identifier`,
		);
	}
	return normalized;
}

export function resolveAutomationAccess(input: {
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly organizationId?: string;
	readonly role: AutomationRole;
}): ResolvedAutomationAccess {
	const organizationId = input.organizationId?.trim();
	if (input.organizationId !== undefined && !organizationId) {
		throw new AutomationStateError(
			"INVALID_SCOPE",
			"organizationId must be non-empty when provided",
		);
	}
	if (organizationId && organizationId.length > 256) {
		throw new AutomationStateError("INVALID_SCOPE", "organizationId is too long");
	}
	return Object.freeze({
		scopeKey: identifier(input.scopeKey, "scopeKey"),
		subjectId: identifier(input.subjectId, "subjectId"),
		...(organizationId === undefined ? {} : { organizationId }),
		role: input.role,
		[automationAccessBrand]: true as const,
	});
}

export function isResolvedAutomationAccess(value: unknown): value is ResolvedAutomationAccess {
	return Boolean(
		value &&
		typeof value === "object" &&
		automationAccessBrand in value &&
		(value as Record<PropertyKey, unknown>)[automationAccessBrand] === true,
	);
}

export type AutomationTrigger =
	| {
			readonly kind: "schedule";
			readonly schedule: string;
			readonly nextRunAt: number;
	  }
	| { readonly kind: "event"; readonly event: string };

export interface AutomationDraft {
	readonly id: string;
	readonly name: string;
	readonly instructions: string;
	readonly trigger: AutomationTrigger;
	readonly enabled: boolean;
	readonly allowedActions: readonly string[];
	readonly expectedRevision?: number;
}

export interface AutomationRecord extends AutomationDraft {
	readonly scopeKey: string;
	readonly organizationId?: string;
	readonly createdBySubjectId: string;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type AutomationJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AutomationJobRecord {
	readonly id: string;
	readonly scopeKey: string;
	readonly automationId: string;
	readonly automationRevision: number;
	readonly idempotencyKey: string;
	readonly status: AutomationJobStatus;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly errorCode?: string;
	readonly errorMessage?: string;
	readonly attempt: number;
	readonly leaseToken?: string;
	readonly leaseExpiresAt?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type ClaimAutomationJobResult =
	| { readonly outcome: "claimed"; readonly job: AutomationJobRecord }
	| { readonly outcome: "in_flight"; readonly job: AutomationJobRecord }
	| { readonly outcome: "replay"; readonly job: AutomationJobRecord };

export interface ClaimAutomationJobInput {
	readonly idempotencyKey: string;
	readonly input?: unknown;
	readonly leaseDurationMs: number;
}

export type AutomationJobSettlement =
	| { readonly status: "succeeded"; readonly output?: unknown }
	| {
			readonly status: "failed";
			readonly errorCode: string;
			readonly errorMessage: string;
	  }
	| { readonly status: "cancelled"; readonly errorMessage?: string };

export interface AutomationReader {
	getAutomation(
		access: ResolvedAutomationAccess,
		automationId: string,
	): Promise<AutomationRecord | null>;
	listAutomations(access: ResolvedAutomationAccess): Promise<readonly AutomationRecord[]>;
	listDueAutomations(
		access: ResolvedAutomationAccess,
		input: { readonly now: number; readonly limit?: number },
	): Promise<readonly AutomationRecord[]>;
	getJob(access: ResolvedAutomationAccess, jobId: string): Promise<AutomationJobRecord | null>;
}

export interface AutomationWriter {
	saveAutomation(
		access: ResolvedAutomationAccess,
		draft: AutomationDraft,
	): Promise<AutomationRecord>;
	claimJob(
		access: ResolvedAutomationAccess,
		automation: AutomationRecord,
		input: ClaimAutomationJobInput,
	): Promise<ClaimAutomationJobResult>;
	heartbeatJob(
		access: ResolvedAutomationAccess,
		job: AutomationJobRecord,
		leaseDurationMs: number,
	): Promise<AutomationJobRecord>;
	settleJob(
		access: ResolvedAutomationAccess,
		job: AutomationJobRecord,
		settlement: AutomationJobSettlement,
	): Promise<AutomationJobRecord>;
}

export type AutomationPersistence = AutomationReader & AutomationWriter;
