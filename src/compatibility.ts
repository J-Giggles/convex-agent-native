export const AGENT_NATIVE_CONVEX_COMPATIBILITY = Object.freeze({
	specificationVersion: "0.1.0-draft.1",
	agentNative: Object.freeze({
		package: "@agent-native/core",
		version: "0.133.2",
		commit: "0546d440276abe565ad58b816d5ee58c0d0dabf4",
	}),
	convexAgent: Object.freeze({
		package: "@convex-dev/agent",
		version: "0.6.4",
		commit: "0aba1879f905d9a0d91ca50cb896ecce563bd995",
	}),
	surfaces: Object.freeze([
		"actions",
		"browser-client",
		"persistence",
		"extensions",
		"mcp",
		"a2a",
		"cli",
		"protocol",
		"convex-agent",
	] as const),
	excluded: Object.freeze(["db-exec", "sql-emulation", "builder-branding"] as const),
});

export type AgentNativeConvexCompatibilitySurface =
	(typeof AGENT_NATIVE_CONVEX_COMPATIBILITY.surfaces)[number];

export function assertCompatibilitySurface(
	surface: string,
): asserts surface is AgentNativeConvexCompatibilitySurface {
	if (!AGENT_NATIVE_CONVEX_COMPATIBILITY.surfaces.some((candidate) => candidate === surface)) {
		throw new RangeError(`Unsupported Agent-Native compatibility surface: ${surface}`);
	}
}
