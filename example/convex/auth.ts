import { resolveActionScope } from "@giggabit/agent-native-convex";
import type { GenericActionCtx, GenericDataModel, UserIdentity } from "convex/server";

type AuthOnlyContext = Pick<GenericActionCtx<GenericDataModel>, "auth">;

function boundedClaim(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Authenticated ${label} is missing`);
	const normalized = value.trim();
	if (!normalized || normalized.length > 160) {
		throw new Error(`Authenticated ${label} is invalid`);
	}
	return normalized;
}

/** Pure policy seam used by tests and every public example function. */
export function deriveHostScope(identity: UserIdentity) {
	const issuer = boundedClaim(identity.issuer, "issuer");
	const subject = boundedClaim(identity.subject, "subject");
	const organizationId = boundedClaim(identity.organization_id, "organization");
	const authority = encodeURIComponent(issuer);
	const organization = encodeURIComponent(organizationId);
	const principal = `${authority}#${encodeURIComponent(subject)}`;
	const scopeKey = `organization:${authority}:${organization}`;
	if (principal.length > 256 || scopeKey.length > 256) {
		throw new Error("Authenticated scope claims are too long");
	}
	return resolveActionScope({
		scopeKey,
		subjectId: principal,
		organizationId,
	});
}

/**
 * Scope is derived from verified Convex auth claims. No public function in this
 * example accepts a subject, organization, or scope key from its arguments.
 */
export async function requireHostScope(ctx: AuthOnlyContext) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error("Authentication required");
	return deriveHostScope(identity);
}
