# ADR-0002: Convex-safe actions and anonymous demo boundaries

Status: accepted

## Decision

Export `defineConvexAction` as the narrow Convex-isolate constructor for the public `@agent-native/core/action` definition contract. It validates and parses Standard Schema input before invoking the handler, validates declared output afterward, requires explicit JSON Schema for tool advertising, and leaves durable invocation and audit persistence to the existing scoped Convex dispatcher. The dispatcher also accepts host-owned, per-invocation execution context, exposed to definitions only through `readActionExecutionContext`; that value is non-enumerable and is neither derived from input nor persisted.

The public demo authenticates a 24-hour anonymous bearer by a stored digest, derives subject and action scope only from that stored session, and never accepts caller-selected authority. Reset rotates the bearer-backed session to a fresh versioned action scope while keeping a stable, server-derived quota identity. Bootstrap authorization uses a fixed Origin allowlist and one server-owned deployment bucket; forwarding headers and request fields cannot select quota identity. Expected public refusals are bounded and redact secrets.

Convex remains the only persistent database for demo tasks, chat, session settings, operations, action invocations, quotas, and audit data. Prior invocation audit remains durable after reset in the old scope, while the newly selected scope begins with only the seeded tasks.

## Context

The pinned upstream `defineAction` runtime at commit `0b77b79d675ef18fad8279ed1921b48ed7c25358` eagerly links its optional SQL audit implementation into Convex HTTP actions even when SQL audit is disabled. That dependency cannot be bundled for the Convex isolate. Public anonymous traffic also requires cost bounds that do not depend on deployment-specific trust in proxy headers.

## Consequences

The demo reuses the exact same module-singleton action definition objects across UI, built-in agent, provider plug-in seam, MCP, and direct HTTP while binding the current Convex task store through trusted execution context. Invalid raw input cannot reach handlers. Reset cannot evade chat, action, or reset quotas because quota identity does not rotate with action scope. A deployment-wide bootstrap limit may temporarily refuse legitimate new sessions during a traffic spike; this is an intentional fail-closed cost boundary.

## Rejected alternatives

- Importing upstream `defineAction` and disabling its audit option was rejected because the optional SQL module is still eagerly linked into the isolate bundle.
- Copying or patching upstream proprietary implementation details was rejected; the adapter uses only the public MIT-licensed type and Standard Schema contracts.
- Trusting `x-forwarded-for`, `x-real-ip`, or vendor headers was rejected because the application cannot prove that every public deployment strips caller-supplied values.
- Deleting historical component audit on reset was rejected because it weakens the durable audit invariant; versioned scopes make the previous state inaccessible without destroying it.
