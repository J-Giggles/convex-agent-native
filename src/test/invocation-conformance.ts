import type { InvocationPersistence } from "../persistence/invocations.js";

export interface InvocationPersistenceConformanceOptions {
	createPersistence: () => Promise<InvocationPersistence> | InvocationPersistence;
}

const binding = {
	actorId: "subject:alpha",
	requestFingerprint: `sha256:${"a".repeat(64)}`,
} as const;

export async function verifyInvocationNormalPath(
	options: InvocationPersistenceConformanceOptions,
): Promise<void> {
	const persistence = await options.createPersistence();
	const claimed = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-1",
		...binding,
		caller: "tool",
	});
	assert(claimed.outcome === "claimed", "first claim must be accepted");

	const inFlight = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-1",
		...binding,
		caller: "tool",
	});
	assert(inFlight.outcome === "in_flight", "running claim must be in flight");

	const completed = await persistence.completeInvocation({
		scopeKey: "org:alpha",
		invocationId: claimed.invocation.id,
		result: { invoiceId: "invoice-1", approved: true },
	});
	assert(completed.status === "completed", "invocation must complete");
	await persistence.completeInvocation({
		scopeKey: "org:alpha",
		invocationId: claimed.invocation.id,
		result: { invoiceId: "invoice-1", approved: true },
	});
	let changedCompletionRefused = false;
	try {
		await persistence.completeInvocation({
			scopeKey: "org:alpha",
			invocationId: claimed.invocation.id,
			result: { invoiceId: "invoice-1", approved: false },
		});
	} catch {
		changedCompletionRefused = true;
	}
	assert(changedCompletionRefused, "a repeated completion must match the exact durable result");

	const replay = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-1",
		...binding,
		caller: "tool",
	});
	assert(replay.outcome === "replay", "terminal claim must replay");
	assert(
		JSON.stringify(replay.invocation.result) ===
			JSON.stringify({ invoiceId: "invoice-1", approved: true }),
		`replay must preserve the completed result (received ${JSON.stringify(replay.invocation.result)})`,
	);
}

export async function verifyInvocationFailurePath(
	options: InvocationPersistenceConformanceOptions,
): Promise<void> {
	const persistence = await options.createPersistence();
	const claimed = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-2",
		...binding,
		caller: "tool",
	});
	assert(claimed.outcome === "claimed", "first claim must be accepted");

	const failed = await persistence.failInvocation({
		scopeKey: "org:alpha",
		invocationId: claimed.invocation.id,
		errorCode: "UPSTREAM_REFUSED",
		errorMessage: "Approval was refused",
	});
	assert(failed.status === "failed", "invocation must fail terminally");
	await persistence.failInvocation({
		scopeKey: "org:alpha",
		invocationId: claimed.invocation.id,
		errorCode: "UPSTREAM_REFUSED",
		errorMessage: "A different non-durable message",
	});
	let changedFailureRefused = false;
	try {
		await persistence.failInvocation({
			scopeKey: "org:alpha",
			invocationId: claimed.invocation.id,
			errorCode: "OTHER_FAILURE",
			errorMessage: "must not replace failure",
		});
	} catch {
		changedFailureRefused = true;
	}
	assert(changedFailureRefused, "a repeated failure must preserve the exact durable error code");

	const replay = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-2",
		...binding,
		caller: "tool",
	});
	assert(replay.outcome === "replay", "failed invocation must replay");
	assert(
		replay.invocation.errorCode === "UPSTREAM_REFUSED",
		"failed replay must preserve the error code",
	);
}

export async function verifyInvocationSafetyInvariant(
	options: InvocationPersistenceConformanceOptions,
): Promise<void> {
	const persistence = await options.createPersistence();
	const claimed = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-3",
		...binding,
		caller: "tool",
	});
	assert(claimed.outcome === "claimed", "first claim must be accepted");

	const crossScope = await persistence.getInvocation({
		scopeKey: "org:beta",
		invocationId: claimed.invocation.id,
	});
	assert(crossScope === null, "cross-scope reads must fail closed");

	const changedActor = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-3",
		actorId: "subject:beta",
		requestFingerprint: binding.requestFingerprint,
		caller: "tool",
	});
	assert(changedActor.outcome === "conflict", "idempotency replay must remain principal-bound");

	const changedCaller = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-3",
		...binding,
		caller: "mcp",
	});
	assert(changedCaller.outcome === "conflict", "idempotency replay must remain caller-bound");

	await persistence.completeInvocation({
		scopeKey: "org:alpha",
		invocationId: claimed.invocation.id,
		result: { approved: true },
	});

	let terminalMutationRefused = false;
	try {
		await persistence.failInvocation({
			scopeKey: "org:alpha",
			invocationId: claimed.invocation.id,
			errorCode: "LATE_FAILURE",
			errorMessage: "must not replace completion",
		});
	} catch {
		terminalMutationRefused = true;
	}
	assert(terminalMutationRefused, "terminal state must be monotonic");

	const unsafe = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-unsafe",
		...binding,
		caller: "tool",
	});
	assert(unsafe.outcome === "claimed", "unsafe projection fixture must claim");
	let unsafeProjectionRefused = false;
	try {
		await persistence.completeInvocation({
			scopeKey: "org:alpha",
			invocationId: unsafe.invocation.id,
			result: {
				rawEmailBody: "full message",
				note: "Bearer live-secret",
				accountNumber: "123456789",
			},
		});
	} catch {
		unsafeProjectionRefused = true;
	}
	assert(unsafeProjectionRefused, "unsafe durable results must be refused");
	const unchanged = await persistence.getInvocation({
		scopeKey: "org:alpha",
		invocationId: unsafe.invocation.id,
	});
	assert(unchanged?.status === "running", "unsafe completion must roll back atomically");

	const narrative = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-narrative",
		...binding,
		caller: "tool",
	});
	assert(narrative.outcome === "claimed", "narrative projection fixture must claim");
	let narrativeRefused = false;
	try {
		await persistence.completeInvocation({
			scopeKey: "org:alpha",
			invocationId: narrative.invocation.id,
			result: {
				content: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			},
		});
	} catch {
		narrativeRefused = true;
	}
	assert(narrativeRefused, "neutral-key narrative results must be refused");

	const numericIdentifier = await persistence.claimInvocation({
		scopeKey: "org:alpha",
		actionName: "invoice.approve",
		idempotencyKey: "request-numeric-identifier",
		...binding,
		caller: "tool",
	});
	assert(numericIdentifier.outcome === "claimed", "numeric identifier fixture must claim");
	let numericIdentifierRefused = false;
	try {
		await persistence.completeInvocation({
			scopeKey: "org:alpha",
			invocationId: numericIdentifier.invocation.id,
			result: { value: 12_345_678 },
		});
	} catch {
		numericIdentifierRefused = true;
	}
	assert(numericIdentifierRefused, "financial-identifier-shaped integers must be refused");
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Invocation persistence conformance failed: ${message}`);
	}
}
