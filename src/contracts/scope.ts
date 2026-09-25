const resolvedScopeBrand: unique symbol = Symbol("agent-native-convex.scope");

/**
 * Trusted scope created by a host after authentication and authorization.
 * Transport payloads must never be cast to this type.
 */
export interface ResolvedActionScope {
	readonly scopeKey: string;
	readonly subjectId: string;
	readonly userEmail?: string;
	readonly organizationId?: string;
	/**
	 * Capability scopes the host granted this principal. An action that declares
	 * `capabilityScopes` runs only when every declared scope is present here.
	 */
	readonly grantedScopes?: readonly string[];
	readonly [resolvedScopeBrand]: true;
}

export function resolveActionScope(input: {
	scopeKey: string;
	subjectId: string;
	userEmail?: string;
	organizationId?: string;
	grantedScopes?: readonly string[];
}): ResolvedActionScope {
	const scopeKey = input.scopeKey.trim();
	const subjectId = input.subjectId.trim();
	const userEmail = input.userEmail?.trim().toLowerCase();
	if (!scopeKey || scopeKey.length > 256 || !subjectId || subjectId.length > 256) {
		throw new Error("Resolved action scope requires bounded non-empty identifiers");
	}
	if (userEmail !== undefined && (!userEmail || userEmail.length > 320)) {
		throw new Error("Resolved action scope requires a bounded user email");
	}
	const grantedScopes =
		input.grantedScopes === undefined
			? undefined
			: Object.freeze([...new Set(input.grantedScopes.map((scope) => scope.trim()))].sort());
	if (grantedScopes?.some((scope) => !scope || scope.length > 128)) {
		throw new Error("Resolved action scope requires bounded non-empty capability scopes");
	}
	return Object.freeze({
		scopeKey,
		subjectId,
		...(userEmail === undefined ? {} : { userEmail }),
		...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
		...(grantedScopes === undefined ? {} : { grantedScopes }),
		[resolvedScopeBrand]: true as const,
	});
}

export function isResolvedActionScope(value: unknown): value is ResolvedActionScope {
	return Boolean(
		value &&
		typeof value === "object" &&
		resolvedScopeBrand in value &&
		(value as Record<PropertyKey, unknown>)[resolvedScopeBrand] === true,
	);
}
