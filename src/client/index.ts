import type { FunctionReference } from "convex/server";
import { useMutation } from "convex/react";

export interface ActionClientRequest<TInput = unknown> {
	[key: string]: unknown;
	actionName: string;
	input: TInput;
	idempotencyKey?: string;
}

export interface ActionClientResult<TResult = unknown> {
	invocationId?: string;
	replayed: boolean;
	result: TResult;
}

export type ActionClientTransport = (request: ActionClientRequest) => Promise<ActionClientResult>;

export interface AgentNativeConvexClient {
	callAction<TInput = unknown, TResult = unknown>(
		actionName: string,
		input: TInput,
		options?: { idempotencyKey?: string },
	): Promise<ActionClientResult<TResult>>;
}

export function createActionClient(transport: ActionClientTransport): AgentNativeConvexClient {
	return {
		callAction<TInput = unknown, TResult = unknown>(
			actionName: string,
			input: TInput,
			options?: { idempotencyKey?: string },
		) {
			return transport({
				actionName,
				input,
				...(options?.idempotencyKey === undefined
					? {}
					: { idempotencyKey: options.idempotencyKey }),
			}) as Promise<ActionClientResult<TResult>>;
		},
	};
}

type ActionMutationReference = FunctionReference<
	"mutation",
	"public",
	ActionClientRequest,
	ActionClientResult
>;

/**
 * React adapter for an app-owned Convex mutation. The mutation must resolve
 * identity/scope server-side before entering the compatibility component.
 */
export function useConvexActionMutation(reference: ActionMutationReference) {
	const mutate = useMutation(reference);
	return async <TInput = unknown, TResult = unknown>(
		actionName: string,
		input: TInput,
		options?: { idempotencyKey?: string },
	): Promise<ActionClientResult<TResult>> =>
		(await mutate({
			actionName,
			input,
			...(options?.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
		})) as ActionClientResult<TResult>;
}
