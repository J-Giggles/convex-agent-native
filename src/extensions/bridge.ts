import {
	executeRegisteredAction,
	type ExecuteRegisteredActionRequest,
	type ExecuteRegisteredActionResult,
	type ExecuteRegisteredActionSecurity,
} from "../action/execute.js";
import type { ActionRegistry } from "../action/registry.js";
import { resolveActionScope } from "../contracts/scope.js";
import { authenticateExtensionRequest } from "../internal/extension-caller.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import { assertExtensionBridgeAction } from "./policy.js";
import type { ExtensionConsentRecord, ExtensionRecord, ResolvedExtensionAccess } from "./types.js";

export interface ExecuteExtensionActionRequest extends Omit<
	ExecuteRegisteredActionRequest,
	"caller" | "scope"
> {
	readonly access: ResolvedExtensionAccess;
	readonly extension: ExtensionRecord;
	readonly consent: ExtensionConsentRecord | null;
	readonly slotId: string;
}

/**
 * Authenticate an extension bridge invocation and preserve that provenance
 * through action authorization, durable claim, approval, and handler dispatch.
 * Direct calls to executeRegisteredAction cannot impersonate this path.
 */
export async function executeExtensionAction(
	registry: ActionRegistry,
	persistence: InvocationPersistence,
	request: ExecuteExtensionActionRequest,
	security: ExecuteRegisteredActionSecurity = {},
): Promise<ExecuteRegisteredActionResult> {
	const registered = registry.get(request.actionName);
	assertExtensionBridgeAction({
		caller: "extension",
		access: request.access,
		extension: request.extension,
		consent: request.consent,
		slotId: request.slotId,
		actionName: request.actionName,
		action: registered.definition,
	});

	const authenticatedRequest = authenticateExtensionRequest({
		actionName: request.actionName,
		input: request.input,
		caller: "extension" as const,
		scope: resolveActionScope({
			scopeKey: request.access.scopeKey,
			subjectId: request.access.subjectId,
			...(request.access.organizationId === undefined
				? {}
				: { organizationId: request.access.organizationId }),
		}),
		...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
		...(request.approvedToolCallKey === undefined
			? {}
			: { approvedToolCallKey: request.approvedToolCallKey }),
		...(request.networkProtocol === undefined ? {} : { networkProtocol: request.networkProtocol }),
		...(request.networkId === undefined ? {} : { networkId: request.networkId }),
		...(request.networkPeer === undefined ? {} : { networkPeer: request.networkPeer }),
	} satisfies ExecuteRegisteredActionRequest);

	return executeRegisteredAction(registry, persistence, authenticatedRequest, security);
}
