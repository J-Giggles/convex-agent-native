# agent-native-convex

`agent-native-convex` is an independent, Convex-native implementation of selected public Agent-Native contracts. It uses semantic persistence ports and native Convex transactions rather than translating SQL.

The compatibility boundary is intentionally narrow: action execution, scoped invocation persistence, browser and CLI clients, MCP and A2A adapters, and the documented example. See [the compatibility statement](docs/compatibility.md) for supported and excluded surfaces.

[Agent-Native](https://agent-native.com/) is created and maintained by [Builder.io](https://www.builder.io/), with official source at [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native). This independent interoperability project is not affiliated with, endorsed by, or sponsored by Builder.io or the Agent-Native project; compatibility names are used only to describe public contracts.

## Install in an existing Convex app

The package can be mounted in any app using Convex `>=1.39.1 <2` on Node.js `>=22.22 <27`:

```sh
npm install @giggabit/agent-native-convex @convex-dev/agent convex
```

Add the component to `convex/convex.config.ts`:

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

Then run `npx convex dev`. Convex generates `components.agentNative`, which host functions pass to `createConvexPersistence`. The policy setting is deliberate: the package never accepts a browser-provided tenant or authorization scope.

See the [copy-paste getting-started guide](docs/getting-started.md) for the first action, component wiring, supported environments, and upgrade notes.

## Public agent-first to-do demo

The [live Convex-backed demo](https://j-giggles.github.io/convex-agent-native/) is an independent port of the to-do workflow in Steve Sewell and Builder.io's [How (and why) to build agent-first apps](https://www.builder.io/blog/agent-first-apps). It demonstrates the same module-singleton Builder-style action definition objects across:

- reactive create, edit, complete, reopen, and delete UI flows;
- a deterministic, zero-model-cost built-in agent;
- the public MCP endpoint at `https://bold-ant-924.convex.site/mcp`; and
- direct action HTTP calls at `https://bold-ant-924.convex.site/demo/action`.

Convex is the demo's only persistent database. Anonymous capabilities are isolated per browser session, expire after 24 hours, and never appear in URLs. Reset rotates that capability to a fresh Convex action scope, restores seeded tasks, and clears its visible chat, pending confirmation, receipt, and idempotency state while retaining prior audit records durably outside the new scope. Hard server-side per-session and deployment-wide operation quotas fail closed; caller-controlled forwarding headers never select a quota bucket, tasks cap at 200 per session, and public provider-backed model cost is zero.

Provider-backed chat is deliberately disabled in the public deployment. `demo/agent/provider.ts` documents a server-only plug-in seam that requires both an explicit enable flag and a code-registered provider; credentials and provider payloads are never persisted.

For local development from a clean checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --dir demo typecheck
pnpm --dir demo test
pnpm --dir demo build
```

The demo lifecycle builds the package first, so package and component subpath declarations are reproducible even when `dist/` is absent. See [public demo operations and MCP usage](docs/public-demo.md) for transport examples and deployment details.

## Development

Use Node.js 22.22 or newer and pnpm. Install dependencies, run the package tests, type-check, and build before creating a package tarball. The example is designed to use Convex as its only persistent database.

Never commit deployment credentials. Configuration belongs in the host environment, and action inputs must not be used to select authorization scope.

New contributors are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), ask usage and design questions in [GitHub Discussions](https://github.com/J-Giggles/convex-agent-native/discussions), and report security concerns through a [private security advisory](https://github.com/J-Giggles/convex-agent-native/security/advisories/new).

## Convex agent tools

`createRegisteredActionTool` adapts an action already stored in `ActionRegistry` for `@convex-dev/agent` and AI SDK. It advertises the registered `defineAction` description and Standard Schema verbatim, while all execution still goes through `executeRegisteredAction`:

```ts
import { createRegisteredActionTool } from "@giggabit/agent-native-convex/agent";
import { createConvexPersistence } from "@giggabit/agent-native-convex/convex";

const createTaskTool = createRegisteredActionTool({
  registry,
  actionName: "create-task",
  ctx,
  async prepareExecution(ctx) {
    await enforceDemoQuota(ctx); // fail closed before claim or execution
    const scope = await resolveTrustedScope(ctx); // never derive scope from tool input
    return {
      scope,
      persistence: createConvexPersistence(ctx, components.agentNative, scope),
    };
  },
});
```

Agent calls are always attributed as `caller: "tool"`. Mutations default their idempotency key to the AI SDK tool-call ID. A host can return a verified approval grant and verifier from `prepareExecution`; conditional approvals are re-evaluated by the dispatcher. By default the model receives only the action result. Set `returnInvocationEnvelope: true` when the host needs the invocation ID and replay marker in the tool output.

The package also exports `defineConvexAction` from `@giggabit/agent-native-convex/action`. It preserves the public `@agent-native/core/action` contract while avoiding the pinned upstream constructor's eager optional SQL-audit linkage, which Convex isolate HTTP actions cannot bundle. Hosts provide an explicit JSON Schema for tool advertising; Standard Schema remains the runtime validation authority and output validation is fail closed.

## License

The project is distributed under the MIT License. Direct runtime dependency licenses and attribution are recorded in `THIRD_PARTY_NOTICES.md`.
