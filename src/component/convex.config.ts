import agent from "@convex-dev/agent/convex.config";
import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * Components do not inherit the host application's auth context. Requiring an
 * explicit policy binding makes it impossible to mount this component without
 * acknowledging that every scope key must be derived by an authenticated host
 * function. Component functions are never suitable as browser-facing scope
 * resolvers.
 */
const component = defineComponent("agent_native_convex", {
	env: {
		HOST_SCOPE_POLICY: v.literal("host-derived-v1"),
	},
});

// Threads, messages, streams, files, and memories remain owned by the official
// Agent component. This component stores compatibility state only.
// Convex replaces component imports with ImportedComponentDefinition objects
// during component analysis. A standards-compliant Node import receives the
// unanalysed definition instead; keep package-subpath imports side-effect safe
// while preserving the real Convex analysis path.
if (
	"componentDefinitionPath" in (agent as object) &&
	typeof (agent as { componentDefinitionPath?: unknown }).componentDefinitionPath === "string"
) {
	component.use(agent, { name: "agent" });
}

export default component;
