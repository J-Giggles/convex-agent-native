# Upstream 0.134.0 to 0.164.7: contract gap against the 0.189 port

**Question.** The 0.2.0 port (`release/0.2.0-upstream-0.189`, plan `.agents/plans/2026-09-26-0930-upstream-0-189-port.md`) moved the pin from `@agent-native/core` 0.133.2 to 0.189.0 but read only the last 100 upstream releases (0.164.9 to 1.0.0) plus a type diff. Which public-contract changes in 0.134.0 through 0.164.7 did that skip, and does the port at `450b5c8` already cover them?

**Source.** `packages/core/CHANGELOG.md` on upstream `main` is compacted to 100 entries and starts at 0.164.9 (`git log` shows `b130f4e chore: remove legacy apps and compact changelogs` and `841f072 chore: expand changelog history windows`, both 2026-08-20). The full history survives at the commit before compaction: [`7eaea25`](https://github.com/BuilderIO/agent-native/blob/7eaea25/packages/core/CHANGELOG.md) (938 entries back to 0.7.84). All 180 entries from 0.164.7 down to 0.134.0 were read from that snapshot. Commit hashes below are upstream changeset hashes as printed in that file. Port coverage was checked by grepping `src/` on this repository at `450b5c8`.

Ignored on instruction: first-party templates, UI, Builder.io gateway and credits, Design/Slides/Clips, auth pages, Desktop and Electron, docs-only entries, Postgres and Netlify deploy mechanics.

## Findings by area

Coverage legend: **covered** (port already enforces it), **n/a** (surface the port does not have and does not claim), **host** (belongs to the Convex host that mounts the port), **gap** (port claims the surface and lacks the rule).

### defineAction metadata and semantics

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.153.5 | `47ba57a` | Optional `grounding` declaration on `defineAction`: an action states that a successful call returns real evidence from a data source, replacing app-side name lists. | **gap.** The 0.189 type diff imports `grounding` additively (plan notes), but `defineConvexAction` neither accepts nor forwards it (`src/action/define.ts`, no hit in `src/`). |
| 0.144.2 | `e139a20` | Action route reads `X-Agent-Native-Session-Id` into `RequestContext.browserSessionId`; `track(name, props, ctx)` takes the run context. | **host.** The port builds the run context in `src/action/execute.ts:238` from the host-resolved scope and has no HTTP action transport; a host that mounts one can carry the header through `executionContext`. |
| 0.134.0 | `46cd162` | Same header introduced for agent traces; PostHog `$exception_list` reshaping and `$ai_trace` tree. | **n/a.** Observability provider work; no port surface. |

### HTTP action exposure

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.164.0 / 0.162.0 | `a2f21dc` / `0b57293` | Calling an action with a verb that does not match its declared `http.method` now throws a typed, non-retryable `action_method_mismatch` naming the action, the sent method and the declared one, instead of a bare 405. | **host.** `defineConvexAction` accepts and passes `http` through (`src/action/define.ts:24,97`) but the package mounts no HTTP action route, so it has nowhere to check the verb. The demo's `/demo/action` route is host code. |
| 0.154.5 | `99a8c34` | Typed action contract conflicts survive the shared HTTP action transport. | **covered** for the port's own transports: `IDEMPOTENCY_CONFLICT`, `INVOCATION_IN_FLIGHT` and the other codes in `src/contracts/error.ts` ride MCP and A2A error data. HTTP is host. |
| 0.161.20 | `814f0ad` | Explicitly public ingestion routes complete cross-origin preflight without credentialed CORS. | **host.** No CORS handling in `src/`. |
| 0.161.15 | `551b583` | `CORS_ALLOWED_ORIGINS` exact match tolerates scheme and host casing, trailing slash, bare domain. | **host.** |
| 0.155.0 | `89f194f` | Action routes fall back to the caller's stored active organization when the cookie session resolves no org; an explicit Personal selection still resolves to none; a database failure propagates instead of reading as "no org". | **host.** `resolveActionScope` (`src/contracts/scope.ts`) takes `organizationId` from the host and refuses caller-selected scope; the fallback rule belongs in the host's resolver. Worth one sentence of host guidance in `docs/getting-started.md`. |
| 0.144.0 | `d3f8794` | Public ping liveness endpoint reachable without a session. | **host.** |
| 0.157.10 | `81fb79e` | Canonical `client_platform` attribution on action calls and agent runs. | **n/a.** Analytics. |

### MCP server behaviour

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.145.4 | `db62d66` | One `mcp: {}` option on `createAgentChatPlugin`; `mcp.catalog: "app"` serves the app's flat tool registry; `builtinCrossAppTools` switch; the `tools/call` gate is the advertised set on every tier; `tool-search` scoped to the advertised set and dropped from flat catalogs; MCP OAuth client-metadata validator accepts extra `grant_types` (Claude's JWT bearer). | **covered / n/a.** The port has exactly one flat catalog equal to the app's externally exposed registry, and `tools/list` and `tools/call` share `isVisible` and `publicConfig` (`src/protocols/mcp.ts:86-100, 252-270`), so the callable set is the advertised set. No cross-app builtins, no `tool-search`, no tiers. OAuth is host-owned (`mcp.ts:199`). |
| 0.145.0 | `48bc314` | `frameworkTools` groups removed from chat, MCP, A2A and background runs while HTTP routes stay mounted. | **n/a.** The port ships no framework tool groups. |
| 0.161.17 / 0.161.18 / 0.161.14 / 0.161.12 | `34496d7` / `9dd50a0` / `96ecc13` / `610103f` | Every tool schema sanitised at the engine boundary: `oneOf` to `anyOf`, unsupported `format` values and `patternProperties`/`not`/`if` dropped, type-less positions given a concrete value union. | **covered** except the last: `normalizeToolParameters` (`src/action/tool-schema.ts`) strips the keywords and rewrites `oneOf`, per 0.2.0. It does not give a bare `{}` (Zod `z.unknown()`) a concrete `type` union (0.161.14). |
| 0.145.6 | `1d5bab1` | OAuth client metadata with extra grant types; OAuth preserved for legacy MCP endpoint configs. | **host.** |
| 0.136.1 | `db4b4f0` | Native OAuth clients may use ephemeral ports on registered loopback redirect URIs. | **host.** |
| 0.146.6 | `a882a53` | MCP client hydration lazy on serverless; unreadable settings raise `McpConfigUnreadableError` instead of "no servers". | **n/a.** MCP client connections to external servers; the port is a server. |
| 0.144.0 | `d3f8794` | Personal or workspace scope for verified MCP integrations. | **n/a.** |

### Approval policy

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.164.0 / 0.162.0 | `a2f21dc` / `0b57293` | `approval_required` carries an `askId` for the specific gate hit; the client keeps one resolution per ask. Grant window extended from 15 minutes to 1 hour. | **partly.** The content-addressed `approvalKey` is ported (0.2.0). `askId` is a chat-transport identifier (plan note: interrupt/resume is a chat contract). The grant TTL is owned by the host's `ApprovalVerifier`; the port states no recommended window. |
| 0.160.2 | `831e915` | Durable approval continuation scopes recovered when clients omit a logical turn id. | **n/a.** Chat transport. |
| 0.161.2 / 0.160.1 / 0.159.x | `772f59a` and re-releases | Approved agent actions stay valid across history replay and are scoped to the current turn. | **covered.** `verifyAndConsume` binds one grant to `approvalKey`, actor and scope and consumes it (`src/action/execute.ts:330-352`). |
| 0.149.2 | `dab8787` | Approval-based tool resumes bound to server-created one-shot records; approved actions run deterministically. | **covered.** Same mechanism. |
| 0.152.0 | `aa17e22` | Tool-approval schema runs in release migrations. | **n/a.** Postgres. |

### Authorization guards, roles and scopes

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.157.0 | `afe636c` | Request-scoped action allowlists for interactive agent chat. | **covered.** `prepareExecution` in `src/agent/registered-action-tool.ts` resolves trusted per-call capabilities and may refuse a call; automations carry `allowedActions`. |
| 0.136.2 | `74f1e73` | Scoped agent-access tokens carry a signed `agentLabel` claim, audit and display only, never consulted for authorisation. | **gap.** `ResolvedActionScope` has `subjectId`, `userEmail`, `organizationId`, `grantedScopes`; nothing names the agent, so audit rows cannot say which agent acted. Prospera's delegated-agent grants need this. |
| 0.159.0 | `d003981` | `defineAppConfig()`; `a2a.allowUnsignedInternal` and `integrations.allowUnverifiedWebhooks` become declared fields; malformed values fail at startup instead of reading as `false`. | **host.** The port has no app-config layer. `src/internal/agent-card.ts` still reads `process.env.A2A_SECRET` directly, matching pre-0.159 upstream; the host decides signing. |
| 0.135.1 | `ed51b3d` | Org-visibility access granted on real organization membership, not only the active organization. | **host.** Sharing surface; the port's scope is host-resolved. |
| 0.153.5 / 0.153.4 | `47ba57a` / `405e17e` | Connected-agent mutations gated to owners and admins. | **n/a.** First-party connected-agent surface. The port's automation roles already refuse mutation to `viewer` and `runner` (`src/automations/policy.ts:369-395`). |
| 0.153.0 | `b3b4580` | Viewer separated from a new Commenter role; workspace connection runtime access restricted to per-user and group grants. | **n/a.** No sharing or connection surface. |
| 0.152.0 | `aa17e22` | Cross-app SSO hardened with bound PKCE codes and fail-closed app registration; role labels customisable without changing persisted roles. | **host / n/a.** |
| 0.163.0 | `a688849` | Organization groups and privacy controls for workspace apps. | **n/a.** |
| 0.154.2 | `4a3849b` | Delegated feature-flag actions authorised through verified organization domains; replayed mutation tokens rejected. | **covered** in principle: the durable idempotency claim binds actor and request (`src/action/execute.ts:290-323`). Feature flags are n/a. |
| 0.146.8 / 0.146.7 / 0.157.13 / 0.157.14 / 0.161.2 | `89d223a` / `718ba9e` / `7dc2c91` / `4d8c36c` / `772f59a` | HMAC- and bearer-verified framework routes reach their own verifier before the browser cookie guard. | **host.** Route ordering. |
| 0.145.3 | `c2b7f82` | Realtime subscribe tokens carry an absolute `absExp`; `accessAllowTtlMs` bounds cached share checks. | **n/a.** No realtime sync in the port. |
| 0.145.1 | `b242acf` | Session and org-membership resolution cached behind short TTLs with write invalidation. | **host.** |
| 0.141.0 / 0.138.0 | `277be3f` / `9d271fe` | Portable security guard contract automatic for every CLI-generated app. | **n/a.** Scaffold guard scripts, not the action CLI adapter. |

### A2A

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.154.1 | `97b3736` | Explicitly exposed authenticated write actions are advertised as message-only A2A capabilities; direct invocation stays read-only. | **gap.** Direct `actions/invoke` is read-only (`src/action/execute.ts:90`) and `message/send` exists, but `skillsForRegistry` (`src/protocols/a2a.ts:296`) lists only read-only actions, so a peer cannot discover a write action it could ask for by message. |
| 0.149.0 | `c41fd16` | Cross-app mutating work must use natural-language delegation, not direct read-only A2A actions. | **covered.** Enforced by the read-only direct gate. |
| 0.164.4 | `c58cd6e` | Verified mutation receipts and exact member identity preserved across Dispatch and A2A delegation. | **covered** in principle: `A2AAuthenticatedContext` is host-verified and the dispatcher returns an invocation envelope as the receipt. |
| 0.161.8 | `adf5cb0` | A selected receiver's declared local capabilities are tried before cross-app delegation. | **n/a.** Caller-side routing. |
| 0.142.0 | `9d8ae68` / `aa24c7e` | Delegated agent is told its real time budget; failed delegated calls surface as tool errors; argument-independent repeated-failure breaker. | **host.** `message/send` hands the task to the host's run function; the agent loop is not in the port. |
| 0.141.7 | `abb0cf5` | A2A terminal code recorded on the `agent_call` event; remote task id attached to every cross-app call. | **covered.** Task history records state transitions and failure status (`src/protocols/a2a.ts:327-360`); the task id is the correlation key. |
| 0.157.18 | `907dfa3` | Registry action scoped to its verified A2A caller. | **n/a.** First-party. |
| 0.157.3 | `3bcc0bd` | Content database intake published through A2A discovery. | **n/a.** |

### CLI adapter

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.136.0 | `2b6fea3` | `agent-native clean` and `doctor --disk`; `upgrade` pins exact versions. | **n/a.** Scaffolding CLI. `ConvexActionCliAdapter` invokes actions from argv and builds no shell string (0.2.0 note). |
| 0.142.0 | `4044d22` | `doctor` `no-env-credentials` allowlists `DATABASE_URL_UNPOOLED` and `FUSION_BRANCH_KIND`. | **n/a.** |
| 0.146.0 | `c440e50` | `agent-native.config.ts` is the canonical typed config filename; audience-specific instruction paths. | **n/a.** |

### Automations and triggers

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.136.0 / 0.135.0 | `2b6fea3` / `41544d8` | Skipped ticks record `lastCheck`, not `lastRun`; `lastError` surfaced; schedules store the IANA zone they were written in and descriptions name it; `automation_runs` history with `list-automation-runs`; a run left `running` past liveness reads as `interrupted`; run rows pruned per automation; completion write re-reads the automation so a mid-run edit survives; unusable `X-User-Timezone` rejected. | **partly.** Job records (`AutomationJobRecord`, `src/automations/types.ts:108`) are the run history with lease expiry standing in for `interrupted`, and `expectedRevision` guards the mid-run edit. The schedule trigger is a five-field cron plus `nextRunAt` with **no timezone** (`src/automations/policy.ts:276-292`): a host cannot record which zone "every day at 8am" was written in. `lastCheck` and `lastError` are derivable from jobs and the host's scheduler. |
| 0.137.4 | `c71d383` | Due automations run concurrently so one job cannot starve the rest. | **covered.** Lease-based `claimJob`. |
| 0.136.4 | `81c522e` | Explicit Run now with unattended delivery and durable run history. | **covered.** `runner` role plus job enqueue. |
| 0.137.0 | `043e5cd` | Shared automation service and run history exposed to template surfaces. | **covered.** `AutomationReader` / `AutomationWriter` ports. |
| 0.148.0 / 0.147.0 | `061896a` / `cf16fae` | Scheduled automation lineage so an action can link work to the exact background run; duplicate recurring dispatch prevented across deployments; organization automations scoped to their owning app. | **covered.** Jobs carry `idempotencyKey` and `automationRevision`; a host passes the job id as `networkId` on the invocation (`src/action/execute.ts:241`). App scoping collapses into `scopeKey`. |
| 0.146.4 | `e959709` | App-owned scheduled automations stay on the scheduler for the app that created them. | **covered** by `scopeKey` + `organizationId` checks (`assertAutomationScope`). |
| 0.153.0 | `b3b4580` | New scheduled automations default to hourly; background automations get the full ten-minute serverless budget. | **n/a / covered.** No default cadence in the port; the lease bound is 5 seconds to 15 minutes. |
| 0.141.4 | `2765110` | Durable scheduler handoff and persisted health diagnostics on serverless. | **n/a.** Convex's scheduler is durable. |
| 0.143.0 | `e177059` | Self-dispatched background work stays on the current deployment; fails closed when the handoff cannot be signed. | **host.** |
| 0.149.3 | `44ac2c4` | Each Slack channel turn requires an explicit mention. | **n/a.** |
| 0.164.5 | `fc85cb2` | Unreadable schedules file raises `CodeAgentSchedulesUnreadableError` instead of reading as empty. | **covered** in principle: persistence failures surface as `PERSISTENCE_FAILURE`. |

### Error envelopes and client session

| Version | Hash | Gist | Port |
| --- | --- | --- | --- |
| 0.164.0 | `a2f21dc` | `action_method_mismatch` (see HTTP). | host |
| 0.137.8 | `718f945` | `useSession` reports `status: "unavailable"` after bounded retries instead of spinning or reading as signed out. | **n/a.** The port's browser client is an action caller with no session hook. |
| 0.161.9 | `3c54d4e` | `setAgentNativeApiDisabled(reason)`; disabled calls throw `AgentNativeApiDisabledError`. | **n/a.** |
| 0.161.1 | `71e1308` | `builder_gateway_internal_error` classifier. | **n/a.** Builder gateway. |
| 0.153.8 | `a97789e` | `reapAllStaleRuns` returns `{ reaped, failed, truncated }`. | **n/a.** Internal. |

## Add to 0.2.1 plan

1. `grounding` on `defineConvexAction`, forwarded to the definition and to the MCP descriptor and A2A skill (upstream 0.153.5 `47ba57a`).
2. Optional `agentLabel` on `ResolvedActionScope`, written to the audit record and the invocation envelope, never read by any guard (upstream 0.136.2 `74f1e73`).
3. Advertise externally exposed write actions as message-only A2A skills (tag `message-only`, `readOnly: false`) while `actions/invoke` stays read-only (upstream 0.154.1 `97b3736`).
4. Optional IANA `timezone` on the schedule trigger, validated with `Intl.DateTimeFormat`, so a host can compute `nextRunAt` in the zone the schedule was written in (upstream 0.136.0 `2b6fea3`).
5. `normalizeToolParameters` gives a type-less schema position a concrete JSON value union instead of a bare `{}` (upstream 0.161.14 `96ecc13`).
6. Docs: state the recommended approval-grant window (1 hour, upstream 0.164.0 `a2f21dc`) for `ApprovalVerifier` implementers, and the host rule that a session with no active organization falls back to the stored one rather than a null org (upstream 0.155.0 `89f194f`).

## Explicitly declined, with reason

- `action_method_mismatch` error and typed HTTP contract conflicts (0.164.0 `a2f21dc`, 0.154.5 `99a8c34`): the package mounts no HTTP action route; the verb check lives with the host that does.
- `askId` on `approval_required` and durable continuation-scope recovery (0.164.0 `a2f21dc`, 0.160.2 `831e915`): chat interrupt/resume transport, outside the port's dispatcher contract, as the 0.2.0 plan already recorded.
- `X-Agent-Native-Session-Id` into `browserSessionId` and `client_platform` attribution (0.144.2 `e139a20`, 0.134.0 `46cd162`, 0.157.10 `81fb79e`): host transport and analytics; `executionContext` already carries host-only per-call data.
- CORS normalisation, public preflight, ping endpoint, bearer/HMAC route ordering, session caching (0.161.15, 0.161.20, 0.144.0, 0.146.8 family, 0.145.1): host routing and auth middleware.
- `mcp: {}` catalog tiers, `builtinCrossAppTools`, `tool-search`, `frameworkTools` (0.145.4 `db62d66`, 0.145.0 `48bc314`): the port has one flat catalog equal to the exposed registry, already the `mcp.catalog: "app"` shape, and no framework tool groups.
- MCP OAuth grant-type acceptance and loopback redirect rules (0.145.6, 0.145.4, 0.136.1): MCP OAuth is host-owned (`src/protocols/mcp.ts:199`).
- `defineAppConfig` and its `a2a` / `integrations` fields (0.159.0 `d003981`): no app-config layer in the port; signing policy is decided by the host.
- Sharing roles, Commenter, org-membership visibility, workspace groups, connection grants, cross-app SSO (0.153.0, 0.152.0, 0.135.1, 0.163.0): surfaces the port does not implement.
- A2A caller-side routing, delegated time budget, failure breakers (0.161.8, 0.142.0, 0.141.7): the agent loop and the calling side are host code; the port's task history already records terminal state.
- Scaffolding CLI commands and `doctor` allowlists (0.136.0, 0.142.0, 0.146.0): different CLI from the action adapter.
- Automation `lastCheck`/`lastError`, hourly default, ten-minute budget, serverless scheduler handoff, app-owned scheduler pinning (0.136.0, 0.153.0, 0.141.4, 0.146.4, 0.148.0): derivable from job records and `scopeKey`, or Convex-native.
- Client session status and API-disabled switch (0.137.8, 0.161.9): the port's client is an action caller only.
