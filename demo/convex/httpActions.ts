import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { executeDemoAction } from "./actions.js";
import { allowedBootstrapOrigin, corsHeaders, resolveBootstrapRequest } from "./bootstrap.js";
import { capabilityDigest, createCapability } from "./capabilities.js";
import { readDirectActionEnvelope } from "./direct.js";
import { publicHttpFailure } from "./httpErrors.js";
import { handleDemoMcp } from "./mcp.js";

export const sessionOptions = httpAction(async (_ctx, request) => {
  try {
    const origin = allowedBootstrapOrigin(request);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  } catch {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
});

export const sessionPost = httpAction(async (ctx, request) => {
  let policy: ReturnType<typeof resolveBootstrapRequest>;
  try {
    policy = resolveBootstrapRequest(request);
  } catch {
    return new Response(JSON.stringify({ error: "Demo bootstrap unavailable" }), {
      status: 403,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  }
  try {
    const provenanceDigest = await capabilityDigest(policy.provenance);
    await ctx.runMutation(internal.quotas.consume, {
      scopeKey: `demo:bootstrap-${provenanceDigest.slice(0, 16)}`,
      provenanceDigest,
      operation: "session-issue",
      units: 1,
      now: Date.now(),
    });
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const capability = createCapability(entropy);
    const session = await ctx.runMutation(internal.sessions.issue, {
      publicId: capability.publicId,
      secretDigest: await capabilityDigest(capability.secret),
      provenanceDigest,
      now: Date.now(),
    });
    return new Response(
      JSON.stringify({ capability: capability.token, expiresAt: session.expiresAt }),
      {
        status: 201,
        headers: corsHeaders(policy.allowOrigin),
      },
    );
  } catch {
    return new Response(JSON.stringify({ error: "Demo capacity is temporarily unavailable" }), {
      status: 429,
      headers: corsHeaders(policy.allowOrigin),
    });
  }
});

export const directActionPost = httpAction(async (ctx, request) => {
  try {
    const envelope = await readDirectActionEnvelope(request);
    const receipt = await executeDemoAction(ctx, envelope, "http");
    return new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  } catch (error) {
    const failure = publicHttpFailure(error);
    return new Response(JSON.stringify({ error: "Direct action request refused" }), {
      status: failure.status,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  }
});

export const mcpPost = httpAction(async (ctx, request) => {
  try {
    const response = await handleDemoMcp(ctx, request);
    if (response === null) {
      return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  } catch (error) {
    const failure = publicHttpFailure(error);
    const rpcCode =
      failure.code === "invalid_request"
        ? -32600
        : failure.code === "unauthorized"
          ? -32001
          : failure.code === "capacity"
            ? -32002
            : -32603;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: rpcCode, message: "MCP request refused" },
      }),
      {
        status: failure.status,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      },
    );
  }
});
