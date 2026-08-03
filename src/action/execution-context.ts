import type { ActionRunContext } from "@agent-native/core/action";

const executionContextKey: unique symbol = Symbol("agent-native-convex.execution-context");

type ContextWithExecutionData = ActionRunContext & {
	readonly [executionContextKey]?: unknown;
};

export function attachActionExecutionContext<T extends ActionRunContext>(
	context: T,
	value: unknown,
): T {
	Object.defineProperty(context, executionContextKey, {
		value,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return context;
}

/** Read trusted, per-invocation host data that was not supplied in action input. */
export function readActionExecutionContext<T>(context: ActionRunContext | undefined): T {
	if (!context || !(executionContextKey in (context as ContextWithExecutionData))) {
		throw new Error("Action execution context unavailable");
	}
	return (context as ContextWithExecutionData)[executionContextKey] as T;
}
