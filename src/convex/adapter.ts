import type {
	AtomicInvocationPersistence,
	ClaimInvocationResult,
	InvocationRecord,
} from "../persistence/invocations.js";
import type { InvocationAuditEvent, InvocationAuditReader } from "../persistence/audit.js";
import {
	AGENT_NATIVE_CONVEX_ERROR_CODES,
	AgentNativeConvexError,
	isAgentNativeConvexError,
	type AgentNativeConvexErrorCode,
} from "../contracts/error.js";
import { isResolvedActionScope, type ResolvedActionScope } from "../contracts/scope.js";
import { ConvexExtensionPersistence, type ConvexExtensionFunctions } from "../extensions/convex.js";
import type { DefaultFunctionArgs, FunctionReference, GenericDataModel } from "convex/server";

type QueryRef<Args extends DefaultFunctionArgs, Result> = FunctionReference<
	"query",
	"internal",
	Args,
	Result,
	string | undefined
>;
type MutationRef<Args extends DefaultFunctionArgs, Result> = FunctionReference<
	"mutation",
	"internal",
	Args,
	Result,
	string | undefined
>;

export interface AgentNativeConvexComponent {
	invocations: {
		get: QueryRef<{ scopeKey: string; invocationId: string }, InvocationRecord | null>;
		claim: MutationRef<
			{
				scopeKey: string;
				actionName: string;
				idempotencyKey: string;
				actorId: string;
				requestFingerprint: string;
				caller: InvocationRecord["caller"];
			},
			ClaimInvocationResult
		>;
		complete: MutationRef<
			{ scopeKey: string; invocationId: string; result: any },
			InvocationRecord
		>;
		fail: MutationRef<
			{
				scopeKey: string;
				invocationId: string;
				errorCode: string;
				errorMessage: string;
			},
			InvocationRecord
		>;
	};
	audit: {
		listByInvocation: QueryRef<{ scopeKey: string; invocationId: string }, InvocationAuditEvent[]>;
	};
	extensions: ConvexExtensionFunctions;
}

export type ConvexPersistence = AtomicInvocationPersistence & InvocationAuditReader;

type AnyConvexContext = Pick<
	import("convex/server").GenericActionCtx<GenericDataModel>,
	"runQuery" | "runMutation"
>;

function assertScope(scope: ResolvedActionScope): string {
	if (!isResolvedActionScope(scope)) {
		throw new AgentNativeConvexError(
			"INVALID_SCOPE",
			"Convex persistence requires a host-resolved scope",
		);
	}
	return scope.scopeKey;
}

function assertInputScope(boundScope: string, inputScope: string) {
	if (inputScope !== boundScope) {
		throw new AgentNativeConvexError(
			"INVALID_SCOPE",
			"The operation scope does not match its bound host scope",
		);
	}
}

async function asPersistenceCall<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (isAgentNativeConvexError(error)) throw error;
		const data =
			error && typeof error === "object" && "data" in error
				? (error as { data?: unknown }).data
				: undefined;
		const code =
			data && typeof data === "object" && "code" in data
				? (data as { code?: unknown }).code
				: undefined;
		if (
			typeof code === "string" &&
			AGENT_NATIVE_CONVEX_ERROR_CODES.includes(code as AgentNativeConvexErrorCode)
		) {
			throw new AgentNativeConvexError(
				code as AgentNativeConvexErrorCode,
				"Convex persistence rejected the operation",
				{ cause: error },
			);
		}
		throw new AgentNativeConvexError("PERSISTENCE_FAILURE", "Convex persistence operation failed", {
			cause: error,
			retryable: true,
		});
	}
}

/**
 * Bind semantic persistence to the current Convex context and the trusted
 * scope resolved by its host. Callers cannot replace scope through port args.
 */
export function createConvexInvocationPersistence(
	ctx: AnyConvexContext,
	component: AgentNativeConvexComponent,
	scope: ResolvedActionScope,
): ConvexPersistence {
	const scopeKey = assertScope(scope);

	return {
		async getInvocation(input) {
			assertInputScope(scopeKey, input.scopeKey);
			return asPersistenceCall(() =>
				ctx.runQuery(component.invocations.get, {
					scopeKey,
					invocationId: input.invocationId,
				}),
			);
		},

		async claimInvocation(input) {
			assertInputScope(scopeKey, input.scopeKey);
			return asPersistenceCall(() =>
				ctx.runMutation(component.invocations.claim, {
					scopeKey,
					actionName: input.actionName,
					idempotencyKey: input.idempotencyKey,
					actorId: input.actorId,
					requestFingerprint: input.requestFingerprint,
					caller: input.caller,
				}),
			);
		},

		async completeInvocation(input) {
			assertInputScope(scopeKey, input.scopeKey);
			return asPersistenceCall(() =>
				ctx.runMutation(component.invocations.complete, {
					scopeKey,
					invocationId: input.invocationId,
					result: input.result,
				}),
			);
		},

		async failInvocation(input) {
			assertInputScope(scopeKey, input.scopeKey);
			return asPersistenceCall(() =>
				ctx.runMutation(component.invocations.fail, {
					scopeKey,
					invocationId: input.invocationId,
					errorCode: input.errorCode,
					errorMessage: input.errorMessage,
				}),
			);
		},

		async settleInvocation(input) {
			assertInputScope(scopeKey, input.scopeKey);
			const settlement = input.settlement;
			if (settlement.outcome === "completed") {
				return asPersistenceCall(() =>
					ctx.runMutation(component.invocations.complete, {
						scopeKey,
						invocationId: input.invocationId,
						result: settlement.result,
					}),
				);
			}
			return asPersistenceCall(() =>
				ctx.runMutation(component.invocations.fail, {
					scopeKey,
					invocationId: input.invocationId,
					errorCode: settlement.errorCode,
					errorMessage: settlement.errorMessage,
				}),
			);
		},

		async listInvocationAuditEvents(input) {
			assertInputScope(scopeKey, input.scopeKey);
			return asPersistenceCall(() =>
				ctx.runQuery(component.audit.listByInvocation, {
					scopeKey,
					invocationId: input.invocationId,
				}),
			);
		},
	};
}

/** Preferred name now that the bound adapter also exposes audit reads. */
export const createConvexPersistence = createConvexInvocationPersistence;

/**
 * Bind the native extension tables to ordinary Convex runQuery/runMutation
 * capabilities. Extension access remains a separately branded, host-resolved
 * value on every operation.
 */
export function createConvexExtensionPersistence(
	ctx: AnyConvexContext,
	component: AgentNativeConvexComponent,
): ConvexExtensionPersistence {
	return new ConvexExtensionPersistence(
		{
			query: (reference, args) => ctx.runQuery(reference as never, args as never) as Promise<never>,
			mutation: (reference, args) =>
				ctx.runMutation(reference as never, args as never) as Promise<never>,
		},
		component.extensions,
	);
}
