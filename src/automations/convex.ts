import type { FunctionReference } from "convex/server";

import {
	assertAutomationMutationAccess,
	assertAutomationRunAccess,
	assertAutomationScope,
	assertRunningJob,
	assertSafeAutomationPayload,
	createAutomationDraft,
	normalizeLeaseDuration,
} from "./policy.js";
import {
	AutomationStateError,
	isResolvedAutomationAccess,
	type AutomationDraft,
	type AutomationJobRecord,
	type AutomationJobSettlement,
	type AutomationPersistence,
	type AutomationRecord,
	type ClaimAutomationJobInput,
	type ClaimAutomationJobResult,
	type ResolvedAutomationAccess,
} from "./types.js";

interface ConvexAutomationScopeArgs extends Record<string, unknown> {
	scopeKey: string;
	subjectId: string;
	organizationId?: string;
	role: string;
}

type Query<Args extends Record<string, unknown>, Result> = FunctionReference<
	"query",
	"internal",
	Args,
	Result
>;
type Mutation<Args extends Record<string, unknown>, Result> = FunctionReference<
	"mutation",
	"internal",
	Args,
	Result
>;

export interface ConvexAutomationFunctionRunner {
	query<Args extends Record<string, unknown>, Result>(
		reference: Query<Args, Result>,
		args: Args,
	): Promise<Result>;
	mutation<Args extends Record<string, unknown>, Result>(
		reference: Mutation<Args, Result>,
		args: Args,
	): Promise<Result>;
}

export interface ConvexAutomationFunctions {
	readonly getAutomation: Query<
		ConvexAutomationScopeArgs & { automationId: string },
		AutomationRecord | null
	>;
	readonly listAutomations: Query<ConvexAutomationScopeArgs, AutomationRecord[]>;
	readonly saveAutomation: Mutation<ConvexAutomationScopeArgs & AutomationDraft, AutomationRecord>;
	readonly listDueAutomations: Query<
		ConvexAutomationScopeArgs & { now: number; limit: number },
		AutomationRecord[]
	>;
	readonly getJob: Query<ConvexAutomationScopeArgs & { jobId: string }, AutomationJobRecord | null>;
	readonly claimJob: Mutation<
		ConvexAutomationScopeArgs & {
			automationId: string;
			automationRevision: number;
			idempotencyKey: string;
			input?: unknown;
			leaseDurationMs: number;
		},
		ClaimAutomationJobResult
	>;
	readonly heartbeatJob: Mutation<
		ConvexAutomationScopeArgs & {
			jobId: string;
			leaseToken: string;
			leaseDurationMs: number;
		},
		AutomationJobRecord
	>;
	readonly settleJob: Mutation<
		ConvexAutomationScopeArgs & {
			jobId: string;
			leaseToken: string;
			settlement: AutomationJobSettlement;
		},
		AutomationJobRecord
	>;
}

function scopeArgs(access: ResolvedAutomationAccess): ConvexAutomationScopeArgs {
	if (!isResolvedAutomationAccess(access)) {
		throw new AutomationStateError(
			"INVALID_SCOPE",
			"Automation access must be resolved by the host",
		);
	}
	return {
		scopeKey: access.scopeKey,
		subjectId: access.subjectId,
		...(access.organizationId === undefined ? {} : { organizationId: access.organizationId }),
		role: access.role,
	};
}

function assertAutomationResult(
	access: ResolvedAutomationAccess,
	record: AutomationRecord,
	expectedId?: string,
): void {
	assertAutomationScope(access, record);
	createAutomationDraft(record);
	if (
		!Number.isInteger(record.revision) ||
		record.revision < 1 ||
		!record.createdBySubjectId.trim() ||
		record.createdBySubjectId.length > 256
	) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex returned invalid automation revision metadata",
		);
	}
	if (expectedId !== undefined && record.id !== expectedId) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex returned an unexpected automation",
		);
	}
}

function assertJobScope(
	access: ResolvedAutomationAccess,
	job: AutomationJobRecord,
	expected?: { readonly jobId?: string; readonly automationId?: string },
): void {
	if (
		job.scopeKey !== access.scopeKey ||
		(expected?.jobId !== undefined && job.id !== expected.jobId) ||
		(expected?.automationId !== undefined && job.automationId !== expected.automationId)
	) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex returned an automation job outside the requested scope",
		);
	}
	if (job.input !== undefined) assertSafeAutomationPayload(job.input);
	if (job.output !== undefined) assertSafeAutomationPayload(job.output);
	if (job.errorCode !== undefined || job.errorMessage !== undefined) {
		assertSafeAutomationPayload({
			...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
			...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
		});
	}
	const activeLease = Boolean(job.leaseToken) && Number.isFinite(job.leaseExpiresAt);
	if (
		(job.status === "running" && !activeLease) ||
		(job.status !== "running" &&
			(job.leaseToken !== undefined || job.leaseExpiresAt !== undefined)) ||
		(job.status === "failed" && (!job.errorCode || !job.errorMessage)) ||
		(job.status === "succeeded" && (job.errorCode !== undefined || job.errorMessage !== undefined))
	) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex returned an internally inconsistent automation job state",
		);
	}
}

function assertClaimResult(
	access: ResolvedAutomationAccess,
	automation: AutomationRecord,
	input: ClaimAutomationJobInput,
	result: ClaimAutomationJobResult,
): void {
	assertJobScope(access, result.job, { automationId: automation.id });
	if (
		result.job.automationRevision !== automation.revision ||
		result.job.idempotencyKey !== input.idempotencyKey
	) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex returned a job with inconsistent idempotency metadata",
		);
	}
	if (
		(result.outcome === "claimed" || result.outcome === "in_flight") &&
		(result.job.status !== "running" || !result.job.leaseToken)
	) {
		throw new AutomationStateError("PERSISTENCE_FAILURE", "Convex returned an unleased active job");
	}
	if (
		result.outcome === "replay" &&
		result.job.status !== "succeeded" &&
		result.job.status !== "failed" &&
		result.job.status !== "cancelled"
	) {
		throw new AutomationStateError(
			"PERSISTENCE_FAILURE",
			"Convex replay must return a terminal job",
		);
	}
}

/** Convex-only implementation of definition and durable job-state ports. */
export class ConvexAutomationPersistence implements AutomationPersistence {
	constructor(
		private readonly runner: ConvexAutomationFunctionRunner,
		private readonly functions: ConvexAutomationFunctions,
	) {}

	async getAutomation(access: ResolvedAutomationAccess, automationId: string) {
		const record = await this.runner.query(this.functions.getAutomation, {
			...scopeArgs(access),
			automationId,
		});
		if (record) assertAutomationResult(access, record, automationId);
		return record;
	}

	async listAutomations(access: ResolvedAutomationAccess) {
		const records = await this.runner.query(this.functions.listAutomations, scopeArgs(access));
		for (const record of records) assertAutomationResult(access, record);
		return records;
	}

	async listDueAutomations(
		access: ResolvedAutomationAccess,
		input: { readonly now: number; readonly limit?: number },
	) {
		if (access.role === "viewer") {
			throw new AutomationStateError("FORBIDDEN", "Viewer access cannot poll due automations");
		}
		if (!Number.isFinite(input.now)) {
			throw new AutomationStateError(
				"INVALID_AUTOMATION",
				"Due-automation query requires a finite time",
			);
		}
		const records = await this.runner.query(this.functions.listDueAutomations, {
			...scopeArgs(access),
			now: input.now,
			limit: Math.max(1, Math.min(Math.floor(input.limit ?? 100), 100)),
		});
		for (const record of records) {
			assertAutomationResult(access, record);
			if (!record.enabled) {
				throw new AutomationStateError(
					"PERSISTENCE_FAILURE",
					"Convex returned a disabled automation as due",
				);
			}
		}
		return records;
	}

	async saveAutomation(access: ResolvedAutomationAccess, input: AutomationDraft) {
		assertAutomationMutationAccess(access);
		const draft = createAutomationDraft(input);
		const record = await this.runner.mutation(this.functions.saveAutomation, {
			...scopeArgs(access),
			...draft,
		});
		assertAutomationResult(access, record, draft.id);
		if (draft.expectedRevision !== undefined && record.revision !== draft.expectedRevision + 1) {
			throw new AutomationStateError(
				"PERSISTENCE_FAILURE",
				"Convex returned an inconsistent automation revision",
			);
		}
		return record;
	}

	async getJob(access: ResolvedAutomationAccess, jobId: string) {
		const job = await this.runner.query(this.functions.getJob, {
			...scopeArgs(access),
			jobId,
		});
		if (job) assertJobScope(access, job, { jobId });
		return job;
	}

	async claimJob(
		access: ResolvedAutomationAccess,
		automation: AutomationRecord,
		input: ClaimAutomationJobInput,
	) {
		assertAutomationRunAccess(access, automation);
		const idempotencyKey = input.idempotencyKey.trim();
		if (!idempotencyKey || idempotencyKey.length > 256) {
			throw new AutomationStateError(
				"IDEMPOTENCY_KEY_REQUIRED",
				"Automation job requires a bounded idempotency key",
			);
		}
		if (input.input !== undefined) assertSafeAutomationPayload(input.input);
		const result = await this.runner.mutation(this.functions.claimJob, {
			...scopeArgs(access),
			automationId: automation.id,
			automationRevision: automation.revision,
			idempotencyKey,
			...(input.input === undefined ? {} : { input: input.input }),
			leaseDurationMs: normalizeLeaseDuration(input.leaseDurationMs),
		});
		assertClaimResult(access, automation, { ...input, idempotencyKey }, result);
		return result;
	}

	async heartbeatJob(
		access: ResolvedAutomationAccess,
		job: AutomationJobRecord,
		leaseDurationMs: number,
	) {
		assertRunningJob(access, job);
		const updated = await this.runner.mutation(this.functions.heartbeatJob, {
			...scopeArgs(access),
			jobId: job.id,
			leaseToken: job.leaseToken,
			leaseDurationMs: normalizeLeaseDuration(leaseDurationMs),
		});
		assertJobScope(access, updated, { jobId: job.id });
		if (updated.status !== "running" || updated.leaseToken !== job.leaseToken) {
			throw new AutomationStateError(
				"PERSISTENCE_FAILURE",
				"Convex heartbeat changed the running job lease unexpectedly",
			);
		}
		return updated;
	}

	async settleJob(
		access: ResolvedAutomationAccess,
		job: AutomationJobRecord,
		settlement: AutomationJobSettlement,
	) {
		assertRunningJob(access, job);
		if (settlement.status === "succeeded" && settlement.output !== undefined) {
			assertSafeAutomationPayload(settlement.output);
		}
		if (settlement.status === "failed") {
			assertSafeAutomationPayload({
				errorCode: settlement.errorCode,
				errorMessage: settlement.errorMessage,
			});
		}
		if (settlement.status === "cancelled" && settlement.errorMessage !== undefined) {
			assertSafeAutomationPayload({ errorMessage: settlement.errorMessage });
		}
		const updated = await this.runner.mutation(this.functions.settleJob, {
			...scopeArgs(access),
			jobId: job.id,
			leaseToken: job.leaseToken,
			settlement,
		});
		assertJobScope(access, updated, { jobId: job.id });
		if (updated.status !== settlement.status) {
			throw new AutomationStateError(
				"PERSISTENCE_FAILURE",
				"Convex returned an inconsistent terminal job state",
			);
		}
		return updated;
	}
}
