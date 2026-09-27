# One Action registry for a Convex app

This recipe is for a Convex and Next.js app that already has backend functions. It follows Prospera's migration, but its catalogue, authorization model, transports and rollout choices belong to your app. The port's [getting-started guide](getting-started.md) covers the package API; this recipe covers the order of integration and the tests that keep it safe. Paths prefixed `giggabit-prospera/` identify examples in that repository, not files to copy. Prospera's S4, S5 and S9 work is still open; do not treat this as proof that its full migration or OAuth flow is shipped.

## Action and Surface

An **Action** is a named, validated capability with a handler, authorization requirements, effect class and exposure rules. A **Surface** is a way to discover or invoke it: UI, in-app agent, MCP, HTTP, CLI, A2A or, later, WebMCP. Define each capability once in an `ActionRegistry`. A transport may translate names and envelopes, but it must not create another policy or execution path. Keep server-only functions out of the registry until you intend to make them Actions. See `giggabit-prospera/packages/backend/convex/_lib/agentNative/registry.ts`.

## Prerequisites and mount

Inventory your functions, existing tool lists, callers, identity sources, approval paths and audit records. Separate implemented handlers from catalogue entries and from activated entries. Assign each Action a stable name, input and output contracts, read or write effect, required capabilities and allowed clients. Decide which legacy refusal text and wire contracts clients depend on before replacing a transport.

Install the versions supported by [getting-started](getting-started.md): `@giggabit/agent-native-convex`, `@convex-dev/agent` and `convex`. Mount `@giggabit/agent-native-convex/convex.config.js` in `convex/convex.config.ts` with `name: "agentNative"` and `env: { HOST_SCOPE_POLICY: "host-derived-v1" }`. Run Convex code generation so `components.agentNative` exists. The component mounts `@convex-dev/agent` as a child even if your app does not use its tool wrapper. Install `@agent-native/core` if your code or type-checker needs its imported declaration types; an optional peer can still be required by emitted `.d.ts` files. Check this with `skipLibCheck` disabled rather than treating permissive type checking as proof. Prospera recorded this dependency trap in its `.agents/plans/2026-09-26-0100-agent-native-registry.md` Notes.

## Ten steps

### 0. Install without changing behavior

**Goal.** Establish a working component and generated reference. **Build.** Mount the component, bind its version, and retain existing function calls. **Invariant.** A browser input never chooses tenant, subject or capability scope. **Test.** A generated host function resolves `components.agentNative` and refuses a caller-supplied scope. **Trap.** A package can install while its optional peer is still needed for declarations, or code generation can succeed only against a reachable deployment. See `giggabit-prospera/packages/backend/convex/convex.config.ts` and [compatibility](compatibility.md).

### 1. Build the registry

**Goal.** Give each implemented capability one definition. **Build.** Map existing function contracts to `defineConvexAction` entries in one `ActionRegistry`. Supply explicit tool JSON Schema and runtime Standard Schema, `readOnly`, capability scopes and exposure flags. Use stable name translation where old tools use camelCase: the port's action names are lower-case kebab-case. Keep descriptor-only listing separate from handler imports if your writer inventory follows call graphs. **Invariant.** Runtime validation accepts the same supported inputs the advertised schema describes; both schemas must cover adapter branches, including `oneOf` and nullable fields. **Test.** Compare descriptors, names and accepted/refused inputs against the old catalogue for every registered handler. **Trap.** A catalogue schema narrower than the existing adapter silently removes valid modes. See `giggabit-prospera/packages/backend/convex/_lib/agentNative/{registry,inputSchema}.ts` and `docs/research/chat-tool-catalogue-join.md` there.

### 2. Add one trusted dispatcher

**Goal.** Route calls through one validated and audited entry point. **Build.** Add an internal Convex function that receives a verified host auth context, derives `resolveActionScope` with granted capabilities, binds `createConvexInvocationPersistence`, then calls `executeRegisteredAction`. Each Surface verifies identity first; neither the action input nor a public caller supplies the resolved context. For existing write families, call their policy-backed executor rather than their bare handler. **Invariant.** Every write authorizes before the claim, has an idempotency key, and has a safe secret-free replay projection; reads do not need claims. Keep one approval authority and one audit policy. **Test.** A revoked or narrowed grant cannot invoke a write or claim its key, and retrying an authorized write cannot repeat the effect. **Trap.** A status-only replay projection is not the original write envelope; legacy families may need their own business idempotency alongside transport keys. See `giggabit-prospera/packages/backend/convex/_lib/agentNative/{invoke,registry}.ts` and `convex/agentNative.ts` there.

### 3. Replace MCP dispatch without replacing its wire contract

**Goal.** Serve the existing MCP clients from registry definitions. **Build.** Translate descriptors back into the established tool names, order, schema, metadata, pagination and refusals; route calls to the dispatcher behind the existing authentication, session, activation and audit gates. **Invariant.** Client-visible list and call outputs stay compatible, including error codes and catalogue digests. **Test.** Compare a pinned `tools/list` response byte-for-byte and run one read, one write preparation and one refusal through both paths. **Trap.** The port's generic MCP adapter can change names, flatten `oneOf`, add annotations, omit `_meta`, sanitize result text and alter denial envelopes. Use thin codecs over one policy path instead of accepting a new wire contract accidentally. See `giggabit-prospera/packages/backend/convex/_lib/agentNative/mcp.ts` and its `__tests__/mcpToolsList.test.ts`.

### 4. Activate reads with their migrations

**Goal.** Make verified reads discoverable without a bulk exposure change. **Build.** Separate implementation from activation. Keep an explicit activated set and narrow its listings by live grants. Enable each read when its owning in-app agent pack migrates. **Invariant.** Registration alone never advertises an Action; an excluded entity or account stays excluded from every Surface. **Test.** Before activation the read is hidden; after pack migration an authorized caller sees it while a narrowed caller does not. **Trap.** A single all-reads switch exposes unreviewed capabilities. Prospera superseded that plan with `giggabit-prospera/docs/adr/0075-migrate-the-in-app-agent-onto-the-action-registry-one-pack-at-a-time.md`.

### 5. Move the in-app agent one pack at a time

**Goal.** Remove the second set of hand-written tools. **Build.** Generate AI SDK tools from registry descriptors and call the internal dispatcher with `caller: "tool"`. Catalogue chat-only operations; retire duplicate names with a traceable mapping. Move one domain pack per PR and delete its old tool definitions. Route pending approvals through the same write workflow used by other clients. **Invariant.** Agent tool input has no extra authority, and the pack's supported Actions have parity on agent, MCP and HTTP. **Test.** One end-to-end agent read and, if present, one exact write through approval, plus existing MCP tests for that pack. **Trap.** `createRegisteredActionTool` targets `@convex-dev/agent`; a plain AI SDK app needs its own thin adapter or a port addition. Calls to models, embeddings or the web must be Convex actions, never outbound work inside a mutation or an automatic Tier A write. See Prospera ADR 0075 and `giggabit-prospera/docs/research/chat-tool-catalogue-join.md`.

### 6. Add HTTP actions

**Goal.** Let non-MCP clients invoke the same Actions. **Build.** Put a bounded JSON HTTP codec in front of the authenticated dispatcher and existing write policy. Check the method, body size, content type, grant and runtime session. Return stable success, approval and error envelopes. **Invariant.** HTTP cannot bypass MCP-equivalent capability, activation, finance or audit checks. **Test.** Invoke an authorized read, reject an unavailable Action and prepare a write; check response and audit attribution. **Trap.** Requiring `Idempotency-Key` does not itself guarantee transport-level replay. Prospera uses a transient claim for legacy approval families; the body still needs the family's `businessIdempotencyKey` or `actionCommandId`. Define and test the retry contract before promising exactly-once responses. See `giggabit-prospera/packages/backend/convex/_httpActions/handleAgentNativeHttp.ts`.

### 7. Add a CLI

**Goal.** Make Actions usable from a terminal without another catalogue. **Build.** List actions through HTTP, accept JSON or stdin, validate availability, forward the grant and write key, and map error envelopes to exit codes. **Invariant.** The CLI cannot turn a refused or pending write into success, and a generated transport key does not replace business replay keys. **Test.** A denied Action exits nonzero; a write retry with the same family key does not repeat the effect. **Trap.** The port's `ConvexActionCliAdapter` expects a Convex invocation transport; an existing bearer-token CLI may need a thin HTTP client instead. See `giggabit-prospera/packages/prospera-ai/src/action-http.mjs`.

### 8. Add A2A without widening authority

**Goal.** Advertise only Actions the A2A caller can use. **Build.** Serve a scoped agent card and JSON-RPC codec through the same authenticated dispatcher. Start with activated reads if task persistence and write lifecycle are not ready. **Invariant.** The card, invocation gate and grant agree; A2A errors preserve stable codes and audit attribution. **Test.** A grant-visible read appears and runs; a write is absent and refused before dispatch. **Trap.** The port's A2A adapter may change errors or bypass a host's established runtime policy. A thin codec can preserve it. Prospera supports direct `actions/invoke` reads, not durable `tasks/send`; see `giggabit-prospera/packages/backend/convex/_lib/agentNative/a2a.ts` and `_httpActions/handleAgentNativeHttp.ts`.

### 9. Add external OAuth and decide WebMCP exposure

**Goal.** Let independent clients obtain bounded grants without borrowing an in-app session. **Build.** If external agents need it, implement OAuth 2.1 authorization code with PKCE, protected-resource and authorization-server metadata, client registration, consent and token revocation. Convert tokens into the same verified scope the dispatcher already accepts. Assess WebMCP Action by Action; `mcpTool` and `endsTurn` eligibility affect external exposure under the port's documented compatibility rules. **Invariant.** OAuth never creates a broader grant than consent or lets a transport override scope; WebMCP does not inherit access merely because an Action exists. **Test.** A new client completes PKCE, lists and calls one scoped read, prepares but cannot execute an unapproved write, and loses access after revocation. **Trap.** A `direct_oauth` label is not an issuer or proof of client conformance. Prospera has not shipped S9; see `giggabit-prospera/docs/research/direct-oauth-conformance-evidence.md` and [compatibility](compatibility.md).

## Decide before starting

- Which writes need exact human approval, which reversible writes can run automatically, and who owns the approval record?
- When does each Action become active, and who reviews a pack before external exposure?
- Which Actions may appear in WebMCP, including `endsTurn` and explicit `mcpTool` settings?
- Which external clients need OAuth, which grant scopes can they request, and how are consent and revocation enforced?
- What does a replay return after a completed, pending or failed write? Is `Idempotency-Key` a transport claim, a family key, or both?

## Parity checklist

Copy one row per Action. Fill cells with evidence links or `absent`, not an assumed check mark. Record an implemented but inactive Action as inactive.

| Action and effect | Definition and schemas | Grant, approval and replay | UI | Agent | MCP | HTTP | CLI | A2A | WebMCP | Activation and proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<name>` (`read` or `write`) | `<definition, input/output tests>` | `<scope, decision, key, projection>` | `<test>` | `<pack test>` | `<wire test>` | `<HTTP test>` | `<exit test>` | `<card/call test>` | `<eligible or excluded>` | `<status, review, e2e>` |
