export const AGENT_NATIVE_CONVEX_ERROR_CODES = [
	"ACTION_NOT_FOUND",
	"ACTION_NOT_EXPOSED",
	"APPROVAL_REQUIRED",
	"APPROVAL_INVALID",
	"ACTION_INPUT_INVALID",
	"ACTION_OUTPUT_INVALID",
	"ACTION_NOT_AUTHORIZED",
	"IDEMPOTENCY_KEY_REQUIRED",
	"IDEMPOTENCY_CONFLICT",
	"INVOCATION_IN_FLIGHT",
	"INVOCATION_FAILED",
	"INVOCATION_REPLAY_UNAVAILABLE",
	"INVALID_SCOPE",
	"PERSISTENCE_FAILURE",
	"UNSAFE_ACTION_DEFINITION",
	"UNSAFE_PERSISTED_RESULT",
] as const;

export type AgentNativeConvexErrorCode = (typeof AGENT_NATIVE_CONVEX_ERROR_CODES)[number];

export class AgentNativeConvexError extends Error {
	readonly code: AgentNativeConvexErrorCode;
	readonly retryable: boolean;
	readonly details: Readonly<Record<string, unknown>> | undefined;

	constructor(
		code: AgentNativeConvexErrorCode,
		message: string,
		options: {
			cause?: unknown;
			retryable?: boolean;
			details?: Readonly<Record<string, unknown>>;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AgentNativeConvexError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.details = options.details;
	}
}

export function isAgentNativeConvexError(error: unknown): error is AgentNativeConvexError {
	return error instanceof AgentNativeConvexError;
}
