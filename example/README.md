# One-database Convex example

This example keeps counters, idempotent action invocations, thread ownership, messages, and streaming deltas in one Convex deployment. It uses public Agent-Native action contracts and the official Convex Agent component.

Install `@giggabit/agent-native-convex`, `@agent-native/core`, `@convex-dev/agent`, and the model-provider packages selected by the host application. Copy the `convex/` and `client/` directories into a Convex app, configure its normal authentication provider, and generate the app's Convex references.

Every public function derives its scope from verified authentication claims. The action mutation validates its definition, binds idempotency and counter changes to that scope, and refuses client-selected scope identifiers. Thread queries reauthorize before returning messages or streaming deltas.

Provider credentials belong only in server-side environment configuration. Production hosts must also rate-limit public functions, enforce approval policy before consequential actions, bound model usage, and deliberately select public result shapes.

This example and package are independent interoperability work. They are not affiliated with, endorsed by, or sponsored by Builder.io or the Agent-Native project.
