import type { ActionDefinition, ActionRunContext } from "@agent-native/core/action";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { AgentNativeConvexError, isAgentNativeConvexError } from "../contracts/error.js";
import { isResolvedActionScope, type ResolvedActionScope } from "../contracts/scope.js";
import { isAuthenticatedExtensionRequest } from "../internal/extension-caller.js";
import type { InvocationPersistence, InvocationRecord } from "../persistence/invocations.js";
import type { ActionPolicyContext, ActionRegistry } from "./registry.js";
import { deriveApprovalKey } from "./approval.js";
import { isExposedToExternalAgents, isExposedToInAppAgent, isExternalAgentSurface } from "./exposure.js";
import { fingerprintActionInput } from "./fingerprint.js";
import { attachActionExecutionContext } from "./execution-context.js";
import { assertSafePersistedValue, sanitizeErrorMessage } from "./sanitize.js";

export type ActionSurface = ActionRunContext["caller"] | "extension";

export interface ExecuteRegisteredActionRequest {
	actionName: string;
	input: unknown;
	caller: ActionSurface;
	scope: ResolvedActionScope;
	idempotencyKey?: string;
	approvedToolCallKey?: string;
	networkProtocol?: "a2a" | "mcp" | "provider-api";
	networkId?: string;
	networkPeer?: string;
	/** Trusted per-invocation host data; never derived from action input or persisted. */
	executionContext?: unknown;
}

export interface ExecuteRegisteredActionResult {
	invocationId?: string;
	replayed: boolean;
	result: unknown;
}

export interface ApprovalVerification {
	approvalGrant: string;
	actorId: string;
	scopeKey: string;
	actionName: string;
	requestFingerprint: string;
	/** Content-addressed key for this exact call; equals the upstream `approvalKey`. */
	approvalKey: string;
	/**
	 * Whether the action opted into standing approvals. When false the verifier
	 * must accept only a single-use grant bound to `approvalKey`; a saved
	 * preference may satisfy the gate only when this is true.
	 */
	allowPersistentApproval: boolean;
}

export interface ApprovalVerifier {
	verifyAndConsume(input: ApprovalVerification): Promise<boolean | ApprovalVerdict>;
}

/** Structured verdict; `persistent: true` reports that a standing grant was used. */
export interface ApprovalVerdict {
	approved: boolean;
	persistent?: boolean;
}

export interface ExecuteRegisteredActionSecurity {
	approvalVerifier?: ApprovalVerifier;
}

function assertSurfaceAllowed(
	request: ExecuteRegisteredActionRequest,
	definition: ReturnType<ActionRegistry["get"]>["definition"],
): void {
	if (request.caller === "extension" && definition.toolCallable !== true) {
		throw new AgentNativeConvexError(
			"ACTION_NOT_EXPOSED",
			`Action ${request.actionName} is not callable from extensions`,
		);
	}
	if (request.caller === "tool" && !isExposedToInAppAgent(definition)) {
		throw new AgentNativeConvexError(
			"ACTION_NOT_EXPOSED",
			`Action ${request.actionName} is not exposed to the agent`,
		);
	}
	if (isExternalAgentSurface(request.caller)) {
		if (!isExposedToExternalAgents(definition)) {
			throw new AgentNativeConvexError(
				"ACTION_NOT_EXPOSED",
				`Action ${request.actionName} is not exposed on public agent protocols`,
			);
		}
		if (request.caller === "a2a" && !definition.publicAgent?.readOnly) {
			throw new AgentNativeConvexError(
				"ACTION_NOT_EXPOSED",
				`A2A direct action ${request.actionName} must be read-only`,
			);
		}
	}
}

async function requiresApproval(
	definition: ReturnType<ActionRegistry["get"]>["definition"],
	input: unknown,
	context: ActionPolicyContext,
): Promise<boolean> {
	if (typeof definition.needsApproval === "function") {
		// The pinned upstream type has not added `extension` yet. The runtime
		// object intentionally retains that exact caller across the upstream seam.
		return Boolean(await definition.needsApproval(input, context as ActionRunContext));
	}
	return definition.needsApproval === true;
}

type RuntimeActionDefinition = ActionDefinition<unknown, unknown> & {
	readonly schema?: StandardSchemaV1;
};

async function validateActionInput(
	definition: RuntimeActionDefinition,
	input: unknown,
): Promise<unknown> {
	if (definition.schema === undefined) {
		throw new AgentNativeConvexError(
			"UNSAFE_ACTION_DEFINITION",
			"Registered actions require a public Standard Schema input contract",
		);
	}
	const validation = await definition.schema["~standard"].validate(input);
	if (validation.issues !== undefined) {
		throw new AgentNativeConvexError(
			"ACTION_INPUT_INVALID",
			"Action input failed schema validation",
		);
	}
	return validation.value;
}

function assertUpstreamAuditDisabled(
	definition: RuntimeActionDefinition,
	isReadOnly: boolean,
): void {
	const upstreamAuditWouldRun = isReadOnly
		? definition.audit?.enabled === true ||
			(definition.audit?.enabled === undefined && definition.audit?.onRead === true)
		: definition.audit?.enabled !== false;
	if (upstreamAuditWouldRun) {
		throw new AgentNativeConvexError(
			"UNSAFE_ACTION_DEFINITION",
			"Disable the upstream SQL audit wrapper and use the scoped persistence audit port",
		);
	}
}

function assertOutputValidationFailClosed(definition: RuntimeActionDefinition): void {
	if (definition.outputSchema !== undefined && definition.outputErrorStrategy !== "strict") {
		throw new AgentNativeConvexError(
			"UNSAFE_ACTION_DEFINITION",
			"Actions with an output schema must use the fail-closed throw strategy",
		);
	}
}

function assertCapabilityScopes(
	request: ExecuteRegisteredActionRequest,
	definition: RuntimeActionDefinition,
): void {
	const required = definition.capabilityScopes ?? [];
	if (required.length === 0) return;
	const granted = new Set(request.scope.grantedScopes ?? []);
	const missing = required.filter((scope) => !granted.has(scope));
	if (missing.length > 0) {
		throw new AgentNativeConvexError(
			"ACTION_NOT_AUTHORIZED",
			`Action ${request.actionName} requires capability scopes the resolved scope does not grant`,
			{ details: { missingScopes: missing } },
		);
	}
}

function isConnectionRequiredError(
	error: unknown,
): error is Error & { provider: string; reason?: string; appId?: string } {
	return (
		error instanceof Error &&
		(error as { agentConnectionRequired?: unknown }).agentConnectionRequired === true &&
		typeof (error as { provider?: unknown }).provider === "string"
	);
}

function isPinnedUpstreamOutputValidationError(
	definition: RuntimeActionDefinition,
	error: unknown,
): boolean {
	return (
		definition.outputSchema !== undefined &&
		error instanceof Error &&
		error.message.startsWith("Action output did not match outputSchema")
	);
}

export async function executeRegisteredAction(
	registry: ActionRegistry,
	persistence: InvocationPersistence,
	request: ExecuteRegisteredActionRequest,
	security: ExecuteRegisteredActionSecurity = {},
): Promise<ExecuteRegisteredActionResult> {
	if (request.caller === "extension" && !isAuthenticatedExtensionRequest(request)) {
		throw new AgentNativeConvexError(
			"ACTION_NOT_AUTHORIZED",
			"Extension actions require authenticated bridge provenance",
		);
	}
	if (!isResolvedActionScope(request.scope)) {
		throw new AgentNativeConvexError(
			"INVALID_SCOPE",
			"Action scope must be resolved by a trusted host",
		);
	}

	const { definition, projectReplayResult, authorizeBeforeClaim } = registry.get(
		request.actionName,
	);
	assertSurfaceAllowed(request, definition);
	assertCapabilityScopes(request, definition as RuntimeActionDefinition);

	const isReadOnly = definition.readOnly === true || definition.publicAgent?.readOnly === true;
	assertUpstreamAuditDisabled(definition as RuntimeActionDefinition, isReadOnly);
	assertOutputValidationFailClosed(definition as RuntimeActionDefinition);

	const validatedInput = await validateActionInput(
		definition as RuntimeActionDefinition,
		request.input,
	);
	const requestFingerprint = await fingerprintActionInput(validatedInput);

	const caller: InvocationRecord["caller"] = request.caller;
	const context: ActionPolicyContext = {
		caller: request.caller,
		actionName: request.actionName,
		...(request.scope.userEmail === undefined ? {} : { userEmail: request.scope.userEmail }),
		...(request.scope.organizationId === undefined ? {} : { orgId: request.scope.organizationId }),
		...(request.networkProtocol === undefined ? {} : { networkProtocol: request.networkProtocol }),
		...(request.networkId === undefined ? {} : { networkId: request.networkId }),
		...(request.networkPeer === undefined ? {} : { networkPeer: request.networkPeer }),
	};
	if (request.executionContext !== undefined) {
		attachActionExecutionContext(context as ActionRunContext, request.executionContext);
	}

	const approvalRequired =
		definition.publicAgent?.isConsequential === true ||
		(await requiresApproval(definition, validatedInput, context));
	if (approvalRequired) {
		if (!request.approvedToolCallKey || security.approvalVerifier === undefined) {
			throw new AgentNativeConvexError(
				"APPROVAL_REQUIRED",
				`Action ${request.actionName} requires a verified approval grant`,
			);
		}
	}

	if (!isReadOnly) {
		if (authorizeBeforeClaim === undefined) {
			throw new AgentNativeConvexError(
				"UNSAFE_ACTION_DEFINITION",
				"Mutating actions require a validated pre-claim host authorization gate",
			);
		}
		const authorized = await authorizeBeforeClaim(validatedInput, context);
		if (authorized === false) {
			throw new AgentNativeConvexError(
				"ACTION_NOT_AUTHORIZED",
				"The authenticated actor is not authorized to invoke this action",
			);
		}
	}

	if (!isReadOnly && !request.idempotencyKey) {
		throw new AgentNativeConvexError(
			"IDEMPOTENCY_KEY_REQUIRED",
			`Mutating action ${request.actionName} requires an idempotency key`,
		);
	}
	if (request.idempotencyKey && projectReplayResult === undefined) {
		throw new AgentNativeConvexError(
			"UNSAFE_ACTION_DEFINITION",
			"Idempotent actions require an explicit replay-result allowlist projection",
		);
	}

	let invocationId: string | undefined;
	if (request.idempotencyKey) {
		const claim = await persistence.claimInvocation({
			scopeKey: request.scope.scopeKey,
			actionName: request.actionName,
			idempotencyKey: request.idempotencyKey,
			actorId: request.scope.subjectId,
			requestFingerprint,
			caller,
		});
		invocationId = claim.invocation.id;
		if (claim.outcome === "conflict") {
			throw new AgentNativeConvexError(
				"IDEMPOTENCY_CONFLICT",
				"The idempotency key is already bound to another actor or request",
			);
		}
		if (claim.outcome === "replay") {
			if (claim.invocation.status === "completed") {
				return {
					invocationId,
					replayed: true,
					result: claim.invocation.result,
				};
			}
			throw new AgentNativeConvexError(
				"INVOCATION_FAILED",
				claim.invocation.errorMessage ?? "The prior invocation failed",
				{ details: { invocationId } },
			);
		}
		if (claim.outcome === "in_flight") {
			throw new AgentNativeConvexError(
				"INVOCATION_IN_FLIGHT",
				"An invocation with this idempotency key is already running",
				{ retryable: true, details: { invocationId } },
			);
		}
	}

	try {
		if (approvalRequired) {
			const allowPersistentApproval = definition.allowPersistentApproval === true;
			const verdict = await security.approvalVerifier!.verifyAndConsume({
				approvalGrant: request.approvedToolCallKey!,
				actorId: request.scope.subjectId,
				scopeKey: request.scope.scopeKey,
				actionName: request.actionName,
				requestFingerprint,
				approvalKey: await deriveApprovalKey(request.actionName, requestFingerprint),
				allowPersistentApproval,
			});
			const approved = typeof verdict === "boolean" ? verdict : verdict.approved;
			const persistent = typeof verdict === "boolean" ? false : verdict.persistent === true;
			if (approved && persistent && !allowPersistentApproval) {
				throw new AgentNativeConvexError(
					"APPROVAL_INVALID",
					`Action ${request.actionName} requires a fresh approval on every call`,
				);
			}
			if (!approved) {
				throw new AgentNativeConvexError(
					"APPROVAL_INVALID",
					"The approval grant is invalid, expired, mismatched, or already used",
				);
			}
			context.approvedToolCallKey = request.approvedToolCallKey!;
		}
		let result: unknown;
		try {
			// Preserve extension provenance at runtime while adapting to the pinned
			// upstream context union, which does not yet declare that surface.
			result = await definition.run(validatedInput, context as ActionRunContext);
		} catch (error) {
			if (isConnectionRequiredError(error)) {
				throw new AgentNativeConvexError(
					"ACTION_CONNECTION_REQUIRED",
					`Action ${request.actionName} needs a connection before it can run`,
					{
						cause: error,
						details: {
							provider: error.provider,
							reason: error.reason ?? "connect",
							...(error.appId === undefined ? {} : { appId: error.appId }),
						},
					},
				);
			}
			if (isPinnedUpstreamOutputValidationError(definition as RuntimeActionDefinition, error)) {
				throw new AgentNativeConvexError(
					"ACTION_OUTPUT_INVALID",
					"Action output failed schema validation",
					{ cause: error },
				);
			}
			throw error;
		}
		if (invocationId) {
			let persistedResult: unknown;
			try {
				persistedResult = projectReplayResult!(result);
				assertSafePersistedValue(persistedResult);
			} catch (cause) {
				throw new AgentNativeConvexError(
					"UNSAFE_PERSISTED_RESULT",
					"The action replay projection was refused by the persistence policy",
					{ cause },
				);
			}
			await persistence.completeInvocation({
				scopeKey: request.scope.scopeKey,
				invocationId,
				result: persistedResult,
			});
		}
		return {
			...(invocationId === undefined ? {} : { invocationId }),
			replayed: false,
			result,
		};
	} catch (error) {
		if (invocationId) {
			await persistence
				.failInvocation({
					scopeKey: request.scope.scopeKey,
					invocationId,
					errorCode: isAgentNativeConvexError(error) ? error.code : "ACTION_EXECUTION_FAILED",
					errorMessage: sanitizeErrorMessage(error),
				})
				.catch(() => undefined);
		}
		throw error;
	}
}
