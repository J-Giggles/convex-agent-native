# Getting started in a Convex app

This guide adds the package to an existing Convex application without copying source files or introducing a second database.

## Supported baseline

- Convex `>=1.39.1 <2`
- Node.js `>=22.22 <27`
- `@convex-dev/agent` `^0.6.4` when mounting the component
- npm and pnpm installation commands are documented below; other npm-compatible clients may work

Convex Cloud and anonymous local Convex development are exercised by this project. Self-hosted production deployments use the same Convex component contract, but are not yet part of the release test matrix.

## 1. Install the component

Using npm:

```sh
npm install @giggabit/agent-native-convex @convex-dev/agent convex
```

Using pnpm:

```sh
pnpm add @giggabit/agent-native-convex @convex-dev/agent convex
```

Add `@agent-native/core` if the host imports its public action contracts directly. Add `react` only when using the package's React client surface.

## 2. Mount it

Create or update `convex/convex.config.ts`:

```ts
import agentNative from "@giggabit/agent-native-convex/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(agentNative, {
  name: "agentNative",
  env: { HOST_SCOPE_POLICY: "host-derived-v1" },
});

export default app;
```

Run:

```sh
npx convex dev
```

Convex analyzes the component and generates a typed `components.agentNative` reference. The npm release gate repeats this flow from a packed tarball in a fresh anonymous local Convex project.

## 3. Bind persistence to a trusted scope

Use the generated component reference only inside Convex functions. Derive the scope from verified host authentication, never from action input:

```ts
import { resolveActionScope } from "@giggabit/agent-native-convex";
import { createConvexPersistence } from "@giggabit/agent-native-convex/convex";
import { components } from "./_generated/api";

const scope = resolveActionScope({
  scopeKey: `organization:${verifiedOrganizationId}`,
  subjectId: verifiedUserId,
  organizationId: verifiedOrganizationId,
});

const persistence = createConvexPersistence(ctx, components.agentNative, scope);
```

The exact identifier derivation depends on the host's identity model. See `example/convex/auth.ts` for a complete fail-closed resolver and `example/convex/actions.ts` for an action mutation.

## 4. Register one action

Define actions once, then reuse the same definition through UI, agent, MCP, A2A, or HTTP adapters. Start with `defineConvexAction` and an `ActionRegistry`; execute through `executeRegisteredAction` so validation, authorization, approval, idempotency, and durable audit stay on one path.

The runnable `example/` is the smallest authenticated integration. The public `demo/` adds a zero-model-cost agent, MCP, direct HTTP actions, quotas, and an intentionally anonymous session model.

## Compatibility and upgrades

The package follows semantic versioning while it is pre-1.0: patch releases contain compatible fixes and documentation, while minor releases may add surfaces and can tighten unsafe behavior. Pin an exact version when release reproducibility matters.

Upgrading from 0.1.x to 0.2.0: the reviewed upstream pin is now `@agent-native/core` 0.189.0. Two behaviours tighten. An approval verifier that returns a standing grant is refused unless the action sets `allowPersistentApproval`, and an action with `endsTurn: true` or `mcpTool: false` disappears from MCP, WebMCP and A2A even when `publicAgent.expose` is set. Actions that declare `capabilityScopes` need the host to pass `grantedScopes` into `resolveActionScope`.

This is a compatibility layer for selected public Agent-Native contracts, not an automatic exporter for every Convex function. Hosts explicitly register safe actions and decide which transports expose them. See [compatibility.md](compatibility.md) and [SECURITY.md](../SECURITY.md).
