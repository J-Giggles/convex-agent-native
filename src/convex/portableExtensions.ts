import type {
	AgentNativeExtensionDefinition,
	AgentNativeExtensionManifest,
} from "@agent-native/core/client/extensions";

import { createInertExtensionRevision, normalizeExtensionManifest } from "../extensions/policy.js";
import type {
	ExtensionManifest,
	ExtensionRevisionDraft,
	ExtensionVisibility,
} from "../extensions/types.js";

/**
 * The stable upstream portable definition is the compatibility input. Native
 * Convex metadata/revisions are intentionally a separate package-owned model.
 */
export interface PortableExtensionInstallation {
	readonly extensionId: string;
	readonly name: string;
	readonly description: string;
	readonly visibility: ExtensionVisibility;
	readonly manifest: ExtensionManifest;
	readonly revision: ExtensionRevisionDraft;
}

function upstreamManifest(
	definition: AgentNativeExtensionDefinition,
): AgentNativeExtensionManifest {
	return {
		...((definition.manifest?.slots ?? definition.slots) === undefined
			? {}
			: { slots: definition.manifest?.slots ?? definition.slots }),
		...((definition.manifest?.requestedActions ?? definition.requestedActions) === undefined
			? {}
			: {
					requestedActions: definition.manifest?.requestedActions ?? definition.requestedActions,
				}),
		...((definition.manifest?.requestedCommands ?? definition.requestedCommands) === undefined
			? {}
			: {
					requestedCommands: definition.manifest?.requestedCommands ?? definition.requestedCommands,
				}),
		...((definition.manifest?.storageScopes ?? definition.storageScopes) === undefined
			? {}
			: {
					storageScopes: definition.manifest?.storageScopes ?? definition.storageScopes,
				}),
	};
}

/**
 * Convert an official portable extension definition into the safe, inert
 * installation accepted by the native component. The host must choose
 * visibility; upstream manifest values remain requests, never authority.
 */
export async function preparePortableExtensionInstallation(
	definition: AgentNativeExtensionDefinition,
	options: {
		readonly visibility: ExtensionVisibility;
		readonly allowedSlots?: readonly string[];
		readonly allowedActions?: readonly string[];
		readonly allowedCommands?: readonly string[];
		readonly allowedStorageScopes?: readonly ("user" | "organization")[];
	},
): Promise<PortableExtensionInstallation> {
	const requested = upstreamManifest(definition);
	const intersection = (
		requestedValues: readonly string[] | undefined,
		allowed: readonly string[],
	) => allowed.filter((value) => requestedValues?.includes(value));
	const storageScopes = (options.allowedStorageScopes ?? []).filter((value) => {
		const upstream = value === "organization" ? "org" : value;
		return requested.storageScopes?.includes(upstream);
	});
	const manifest = normalizeExtensionManifest({
		slots: intersection(requested.slots, options.allowedSlots ?? []),
		requestedActions: intersection(requested.requestedActions, options.allowedActions ?? []),
		requestedCommands: intersection(requested.requestedCommands, options.allowedCommands ?? []),
		storageScopes,
	});
	return Object.freeze({
		extensionId: definition.id,
		name: definition.name,
		description: definition.description ?? "",
		visibility: options.visibility,
		manifest,
		revision: await createInertExtensionRevision({
			extensionId: definition.id,
			content: definition.content,
			summary: "Portable extension",
		}),
	});
}
