import type { ActionDefinition, ActionRunContext } from "@agent-native/core/action";

import { AgentNativeConvexError } from "../contracts/error.js";

export type ActionPolicyContext = Omit<ActionRunContext, "caller"> & {
	/** Exact authenticated surface; extension calls must never impersonate frontend calls. */
	caller: ActionRunContext["caller"] | "extension";
};

export interface RegisteredAction<TInput = unknown, TResult = unknown> {
	readonly name: string;
	readonly definition: ActionDefinition<TInput, TResult>;
	readonly projectReplayResult?: (result: TResult) => unknown;
	readonly authorizeBeforeClaim?: (
		input: TInput,
		context: ActionPolicyContext,
	) => boolean | void | Promise<boolean | void>;
}

export interface RegisterActionOptions<TInput, TResult> {
	/**
	 * Explicit allowlist projection persisted for idempotent replay. It must
	 * return only the smallest non-sensitive result needed to replay the call.
	 */
	projectReplayResult?: (result: TResult) => unknown;
	/** Host policy gate evaluated on validated input before durable claim. */
	authorizeBeforeClaim?: (
		input: TInput,
		context: ActionPolicyContext,
	) => boolean | void | Promise<boolean | void>;
}

export class ActionRegistry {
	readonly #actions = new Map<string, RegisteredAction<any, any>>();

	register<TInput, TResult>(
		name: string,
		definition: ActionDefinition<TInput, TResult>,
		options: RegisterActionOptions<TInput, TResult> = {},
	): this {
		const normalized = name.trim();
		if (!/^[a-z][a-z0-9-]{0,95}$/.test(normalized)) {
			throw new Error(`Invalid action name: ${name}`);
		}
		if (this.#actions.has(normalized)) {
			throw new Error(`Action already registered: ${normalized}`);
		}
		this.#actions.set(normalized, {
			name: normalized,
			definition,
			...(options.projectReplayResult === undefined
				? {}
				: { projectReplayResult: options.projectReplayResult }),
			...(options.authorizeBeforeClaim === undefined
				? {}
				: { authorizeBeforeClaim: options.authorizeBeforeClaim }),
		});
		return this;
	}

	get(name: string): RegisteredAction {
		const action = this.#actions.get(name);
		if (!action) {
			throw new AgentNativeConvexError("ACTION_NOT_FOUND", `Unknown action: ${name}`);
		}
		return action;
	}

	list(): readonly RegisteredAction[] {
		return [...this.#actions.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
}
