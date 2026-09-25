# Compatibility statement

The installable component supports Convex `>=1.39.1 <2` on Node.js `>=22.22 <27`. Convex Cloud and anonymous local development are in the automated release path. Self-hosted production deployments are not yet in the release test matrix and should be validated against the host's exact Convex version before adoption.

This package provides a Convex-native adapter for selected public Agent-Native contracts. Compatibility is limited to the exported actions, Convex-agent/AI-SDK tool adapter, persistence ports, browser client, CLI, MCP, A2A, and example surfaces documented by each release.

It does not emulate SQL, expose arbitrary database operations, or claim compatibility with every upstream export. Convex adapters use native functions, indexes, transactions, reactivity, and component isolation. A separate Drizzle adapter demonstrates that the persistence ports are not specific to one database.

`defineConvexAction` is the narrow compatibility constructor for Convex isolate runtimes. It implements the public `@agent-native/core/action` definition contract, requires explicit tool-advertising JSON Schema, validates and parses input before the handler, and validates declared output after it. This exists because the pinned upstream `defineAction` runtime eagerly links its optional SQL audit store even when audit is disabled; the Convex dispatcher supplies scoped durable audit instead.

`executeRegisteredAction` may carry a non-enumerable, per-invocation host execution context to a reusable definition through `readActionExecutionContext`. The context is host-owned, cannot be selected by action input, and is never fingerprinted or persisted. This permits UI, agent, MCP, and HTTP adapters to register the exact same definition objects while binding a request-local Convex store safely.

External exposure is decided by the action definition alone. `uiOnly` hides an action from every agent, `agentTool: false` hides it from the model, and `mcpTool` narrows external MCP, WebMCP and A2A exposure without widening it; an `endsTurn` action needs `mcpTool: true` to leave the app. An action that declares `capabilityScopes` runs only for a resolved scope that carries every one of them. Approval grants are verified against a content-addressed approval key for the exact call, and a standing grant is accepted only by an action that sets `allowPersistentApproval`. Advertised tool schemas are normalised for model providers; the Standard Schema stays the gate.

Unknown actions, invalid input or output, unauthorized access, missing approval, unsafe public exposure, conflicting idempotency claims, and invalid task transitions fail with stable errors. Caller input cannot select its authorization scope.

Durable invocation claims bind the host-derived scope, authenticated actor, action, idempotency key, and canonical validated-input fingerprint. Mutating actions require a host authorization check before the claim, a host-verified single-use approval grant when approval is required, disabled upstream SQL audit, and an explicit safe replay projection.

This is an independent interoperability implementation. It is not a Builder.io product and is not affiliated with, endorsed by, or sponsored by Builder.io or the Agent-Native project.
