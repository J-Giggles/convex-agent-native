# Changelog

All notable changes are documented here. The project uses semantic versioning, with the normal pre-1.0 allowance for minor-version changes to the public surface.

## 0.2.0 - 2026-09-26

### Changed

- The reviewed upstream pin moves from `@agent-native/core` 0.133.2 to 0.189.0 (commit `089a5a96`). Every type seam the package imports changed additively, so the compile-only snapshot passes without renames.
- External exposure follows the upstream 0.170, 0.177 and 0.183 rules. an explicit `mcpTool` decides external exposure on its own and an unset one inherits `agentTool`, so `agentTool: false` with `mcpTool: true` is an external-only action; `uiOnly` hides an action from every agent surface, and an `endsTurn` action stays in-app unless it sets `mcpTool: true`. `webmcp` is an external caller alongside `mcp` and `a2a`. The explicit `publicAgent` opt-in and the extension `toolCallable` gate stay.
- Approval verification now receives a content-addressed `approvalKey` derived from the action name and validated-input fingerprint, matching the upstream `approval_required` contract, plus `allowPersistentApproval`. A verifier that reports a standing grant is refused unless the action opted in, mirroring upstream 0.175: a fresh approval on every call by default.
- Tool schemas advertised over MCP and in the A2A card are normalised the way upstream 0.187 does: provider-rejected keywords, unsupported `format` values and lookaround `pattern`s are removed, `oneOf` becomes `anyOf`, and a composed root collapses into one object schema. The declared Standard Schema remains the runtime gate.

### Added

- `capabilityScopes` on an action and `grantedScopes` on a resolved scope. An action that declares scopes fails closed with `ACTION_NOT_AUTHORIZED` when the host did not grant them.
- `ACTION_CONNECTION_REQUIRED` error code. An action that throws the upstream `AgentConnectionRequiredError` shape surfaces provider and reason details instead of a generic failure.
- `defineConvexAction` accepts `uiOnly`, `mcpTool`, `endsTurn`, `deferLoading`, `capabilityScopes` and `allowPersistentApproval`.
- Public helpers `deriveApprovalKey`, `isExposedToInAppAgent`, `isExposedToExternalAgents` and `normalizeToolParameters`.

### Notes

- The upstream 0.178.1 CLI shell-injection fix does not apply here. `ConvexActionCliAdapter` never builds a shell string; it parses argv and calls the configured action client.
- Upstream still exposes no persistence adapter interface and ships no Convex code behind its optional `convex` peer, so the independent Convex persistence ports stay.

## 0.1.1 - 2026-08-03

### Added

- Packaged Convex component installation through `convex.config.js`.
- Fresh anonymous local Convex consumer verification in CI.
- Copy-paste installation guide and explicit runtime support boundaries.
- Community code of conduct, governance, support guidance, and contribution templates.

### Changed

- Hardened the Builder-style action adapter, component composition, compatibility tests, and public demo release verification merged after `0.1.0`.
- Expanded attribution to Builder.io's original Agent-Native work while keeping this implementation clearly independent.

## 0.1.0 - 2026-08-02

- Initial public package and Convex-backed agent-first demo.
- Scoped durable action persistence, Agent/AI SDK tools, MCP, A2A, CLI, browser client, Convex and Drizzle adapters, automations, and extensions.
