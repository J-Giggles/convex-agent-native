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
	readonly [resolvedScopeBrand]: true;
}

export function resolveActionScope(input: {
	scopeKey: string;
	subjectId: string;
	userEmail?: string;
	organizationId?: string;
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
	return Object.freeze({
		scopeKey,
		subjectId,
		...(userEmail === undefined ? {} : { userEmail }),
		...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
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
