import { describe, expect, it } from "vitest";

import { readMcpEnvelope } from "./mcp.js";

const CAPABILITY = "demo_AAECAwQFBgcICQoL.DA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("public MCP HTTP envelope", () => {
  it("MCP-N-001 accepts a canonical bearer and bounded JSON-RPC request", async () => {
    const request = new Request("https://demo.convex.site/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "content-type": "application/json",
        "idempotency-key": "mcp-call-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await expect(readMcpEnvelope(request)).resolves.toEqual({
      capability: CAPABILITY,
      idempotencyKey: "mcp-call-1",
      request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
  });

  it("MCP-F-001 refuses unauthenticated, malformed, and oversized requests", async () => {
    const cases = [
      new Request("https://demo.convex.site/mcp", { method: "POST", body: "{}" }),
      new Request("https://demo.convex.site/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: "not-json",
      }),
      new Request("https://demo.convex.site/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: JSON.stringify({ payload: "x".repeat(70_000) }),
      }),
    ];
    for (const request of cases) {
      await expect(readMcpEnvelope(request)).rejects.toThrow("MCP request refused");
    }
  });

  it("MCP-I-001 ignores caller-selected scope and authority fields", async () => {
    const request = new Request("https://demo.convex.site/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list-tasks", arguments: { scopeKey: "demo:admin" } },
        authenticated: true,
        canWrite: true,
      }),
    });
    const envelope = await readMcpEnvelope(request);
    expect(envelope.capability).toBe(CAPABILITY);
    expect(envelope).not.toHaveProperty("scopeKey");
    expect(envelope).not.toHaveProperty("authenticated");
    expect(envelope).not.toHaveProperty("canWrite");
  });
});
