import { resolveActionScope } from "@giggabit/agent-native-convex/contracts";
import { createConvexPersistence } from "@giggabit/agent-native-convex/convex";
import { handleMcpRequest, type McpJsonRpcResponse } from "@giggabit/agent-native-convex/mcp";

import { createTaskActionCatalog } from "../actions/task-actions.js";
import { components, internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import { parseCapability } from "./capabilities.js";
import { createConvexTaskStore } from "./tasks.js";

const MAX_MCP_BODY_BYTES = 66 * 1024;

export interface McpEnvelope {
  capability: string;
  idempotencyKey?: string;
  request: unknown;
}

function refused(): never {
  throw new Error("MCP request refused");
}

export async function readMcpEnvelope(request: Request): Promise<McpEnvelope> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match) refused();
  const capability = match[1]!;
  try {
    parseCapability(capability);
  } catch {
    refused();
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES) refused();
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_MCP_BODY_BYTES) refused();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    refused();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refused();
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,160}$/u.test(idempotencyKey)) refused();
  return {
    capability,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    request: parsed,
  };
}

function requestedActionName(request: unknown): string {
  if (!request || typeof request !== "object") return "read";
  const params = (request as { params?: unknown }).params;
  if (!params || typeof params !== "object") return "read";
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && /^[a-z][a-z0-9-]{0,95}$/u.test(name) ? name : "read";
}

function invocationIdFrom(response: McpJsonRpcResponse | null): string | undefined {
  if (!response?.result || typeof response.result !== "object") return undefined;
  const meta = (response.result as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const invocationId = (meta as { invocationId?: unknown }).invocationId;
  return typeof invocationId === "string" ? invocationId : undefined;
}

export async function handleDemoMcp(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  request: Request,
): Promise<McpJsonRpcResponse | null> {
  const envelope = await readMcpEnvelope(request);
  const session = await ctx.runMutation(internal.sessions.resolve, {
    capability: envelope.capability,
  });
  await ctx.runMutation(internal.quotas.consume, {
    scopeKey: session.scopeKey,
    provenanceDigest: session.provenanceDigest,
    operation: "action",
    units: 1,
    now: Date.now(),
  });
  const scope = resolveActionScope({
    scopeKey: session.scopeKey,
    subjectId: session.subjectId,
    ...(session.organizationId === undefined ? {} : { organizationId: session.organizationId }),
  });
  const actionName = requestedActionName(envelope.request);
  const operationKey = `${actionName}:${envelope.idempotencyKey ?? "read"}`;
  const catalog = createTaskActionCatalog(
    createConvexTaskStore(ctx, scope.scopeKey, operationKey),
  );
  const startedAt = Date.now();
  const response = await handleMcpRequest({
    registry: catalog.registry,
    persistence: createConvexPersistence(ctx, components.agentNative, scope),
    scope,
    request: envelope.request,
    authenticated: true,
    canWrite: true,
    ...(envelope.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: envelope.idempotencyKey }),
    serverName: "convex-agent-native-demo",
    serverVersion: "0.1.0",
  });
  const invocationId = invocationIdFrom(response);
  if (invocationId) {
    await ctx.runMutation(internal.receipts.project, {
      scopeKey: scope.scopeKey,
      invocationId,
      actionName,
      caller: "mcp",
      status: "completed",
      replayed: Boolean(
        response?.result &&
          typeof response.result === "object" &&
          (response.result as { _meta?: { replayed?: unknown } })._meta?.replayed,
      ),
      createdAt: startedAt,
      updatedAt: Date.now(),
    });
  }
  return response;
}
