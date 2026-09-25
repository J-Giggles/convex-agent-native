import type { ActionDefinition } from "@agent-native/core/action";

import type { ActionSurface } from "./execute.js";

type ExposureFlags = Pick<
	ActionDefinition<unknown, unknown>,
	"uiOnly" | "agentTool" | "mcpTool" | "endsTurn" | "toolCallable" | "publicAgent"
>;

/** Surfaces that reach the app from outside its own agent loop. */
export const EXTERNAL_AGENT_SURFACES = Object.freeze(["mcp", "webmcp", "a2a"] as const);

export type ExternalAgentSurface = (typeof EXTERNAL_AGENT_SURFACES)[number];

export function isExternalAgentSurface(surface: ActionSurface): surface is ExternalAgentSurface {
	return (EXTERNAL_AGENT_SURFACES as readonly string[]).includes(surface);
}

/**
 * Whether the app's own agent loop may call the action. Mirrors upstream
 * 0.183: `uiOnly` hides an action from every agent surface, `agentTool: false`
 * hides it from the model while UI, HTTP and CLI keep it.
 */
export function isExposedToInAppAgent(definition: ExposureFlags): boolean {
	if (definition.uiOnly === true) return false;
	return definition.agentTool !== false;
}

/**
 * Whether external agents (MCP, WebMCP, direct A2A) may see the action. Mirrors
 * upstream 0.170 and 0.177: an explicit `mcpTool` decides external exposure on
 * its own, an unset `mcpTool` inherits `agentTool`, and an `endsTurn` action
 * stays in-app unless it opts back in with `mcpTool: true`. So `agentTool:
 * false` with `mcpTool: true` is an external-only action, while `uiOnly`
 * hides the action everywhere. The package additionally keeps its explicit
 * `publicAgent` opt-in and the extension `toolCallable` gate.
 */
export function isExposedToExternalAgents(definition: ExposureFlags): boolean {
	if (definition.uiOnly === true) return false;
	if (definition.toolCallable === false) return false;
	if (definition.publicAgent?.expose !== true) return false;
	if (definition.endsTurn === true) return definition.mcpTool === true;
	return typeof definition.mcpTool === "boolean"
		? definition.mcpTool
		: definition.agentTool !== false;
}
