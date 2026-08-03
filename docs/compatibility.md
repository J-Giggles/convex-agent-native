# Compatibility statement

This package provides a Convex-native adapter for selected public Agent-Native contracts. Compatibility is limited to the exported actions, Convex-agent/AI-SDK tool adapter, persistence ports, browser client, CLI, MCP, A2A, and example surfaces documented by each release.

It does not emulate SQL, expose arbitrary database operations, or claim compatibility with every upstream export. Convex adapters use native functions, indexes, transactions, reactivity, and component isolation. A separate Drizzle adapter demonstrates that the persistence ports are not specific to one database.

`defineConvexAction` is the narrow compatibility constructor for Convex isolate runtimes. It implements the public `@agent-native/core/action` definition contract, requires explicit tool-advertising JSON Schema, validates and parses input before the handler, and validates declared output after it. This exists because the pinned upstream `defineAction` runtime eagerly links its optional SQL audit store even when audit is disabled; the Convex dispatcher supplies scoped durable audit instead.

`executeRegisteredAction` may carry a non-enumerable, per-invocation host execution context to a reusable definition through `readActionExecutionContext`. The context is host-owned, cannot be selected by action input, and is never fingerprinted or persisted. This permits UI, agent, MCP, and HTTP adapters to register the exact same definition objects while binding a request-local Convex store safely.

Unknown actions, invalid input or output, unauthorized access, missing approval, unsafe public exposure, conflicting idempotency claims, and invalid task transitions fail with stable errors. Caller input cannot select its authorization scope.

Durable invocation claims bind the host-derived scope, authenticated actor, action, idempotency key, and canonical validated-input fingerprint. Mutating actions require a host authorization check before the claim, a host-verified single-use approval grant when approval is required, disabled upstream SQL audit, and an explicit safe replay projection.

This is an independent interoperability implementation. It is not a Builder.io product and is not affiliated with, endorsed by, or sponsored by Builder.io or the Agent-Native project.
