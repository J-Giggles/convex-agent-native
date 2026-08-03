# Public demo operations

The public demo is served at <https://j-giggles.github.io/convex-agent-native/> and uses the dedicated production deployment `bold-ant-924`:

- Convex client: `https://bold-ant-924.convex.cloud`
- Convex HTTP actions: `https://bold-ant-924.convex.site`
- MCP: `POST https://bold-ant-924.convex.site/mcp`
- direct action: `POST https://bold-ant-924.convex.site/demo/action`

The deployment contains demo data only. It does not share a project, deployment, table, or credential with another application.

## Anonymous capability

The browser bootstraps a scoped 24-hour bearer capability from `POST /demo/session` and stores it under the single allowlisted `sessionStorage` key `convex-agent-native.demo-capability.v1`. Never place a capability in a URL, committed file, command history, screenshot, or verification artifact. The backend stores only its digest.

For an MCP client, obtain a fresh capability through the same bootstrap route with the canonical Pages `Origin`, keep it in the client's secret/environment configuration, and send it as `Authorization: Bearer <capability>`. Mutating calls also require a bounded `Idempotency-Key` header.

An MCP initialization request is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "demo-client", "version": "1.0.0" }
  }
}
```

`tools/list` exposes `list-tasks`, `create-task`, `update-task`, and `delete-task`. The server derives scope, subject, write authority, and caller identity from the bearer; JSON-RPC parameters cannot override them. Consequential agent/MCP deletion requires a verified approval and therefore fails closed without one. The built-in chat provides a durable, single-use confirmation flow.

Direct actions use a bounded JSON body:

```json
{
  "actionName": "create-task",
  "input": { "title": "Try the shared action" }
}
```

Every successful write returns an invocation ID and projects a bounded, capability-scoped audit receipt. UI, chat, MCP, and direct HTTP all use the same task tables and dispatcher.

## Safety and reset

- bootstrap: 5 sessions per provenance per hour;
- chat: 8 turns per session per minute;
- actions: 60 calls per session per minute;
- reset: 3 resets per session per hour;
- deployment: 5,000 charged units per day.

The server rejects unknown origins for browser bootstrap, malformed or oversized HTTP bodies, caller-selected scope, missing write idempotency, invalid/expired capabilities, and quota exhaustion. Reset is scoped to the current anonymous session and atomically restores the two seeded tasks while clearing its chat and action state.

## Provenance

This is an independent Convex port inspired by Steve Sewell and Builder.io's [How (and why) to build agent-first apps](https://www.builder.io/blog/agent-first-apps). The official MIT-licensed reference is [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native); implementation inspection was pinned to commit `0b77b79d675ef18fad8279ed1921b48ed7c25358`. No proprietary material or Builder.io branding is copied, and no affiliation or endorsement is claimed.
