# ADR-0001: Domain persistence ports

Status: accepted

## Decision

Persistence is expressed as small domain operations such as claiming and settling an invocation or transitioning an A2A task. Adapters do not expose raw SQL, arbitrary table selection, or underlying database handles.

The Convex adapter performs invariant-sensitive changes inside native component functions and transactions. The Drizzle reference adapter performs the same operations with real schemas and transactions. A shared conformance suite checks both adapters.

## Consequences

Authorization scope, idempotency, monotonic transitions, and redacted audit projection can be enforced beneath every transport. Adding a genuinely new invariant may require a new port operation, and arbitrary SQL stores are deliberately not portable through this interface.

## Rejected alternatives

SQL emulation over Convex was rejected because it would provide misleading semantics and unsafe dynamic query translation. A Convex-only repository was rejected because a second real adapter is needed to demonstrate that the interface is a domain boundary rather than a database-shaped wrapper.
