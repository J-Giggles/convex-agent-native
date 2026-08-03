import { describe, expect, it } from "vitest";

import { readDirectActionEnvelope } from "./direct.js";

const CAPABILITY = "demo_AAECAwQFBgcICQoL.DA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("public direct action HTTP envelope", () => {
  it("HTTP-N-001 accepts a bounded action request with a canonical bearer", async () => {
    const request = new Request("https://demo.convex.site/demo/action", {
      method: "POST",
      headers: {
        authorization: `Bearer ${CAPABILITY}`,
        "content-type": "application/json",
        "idempotency-key": "direct-create-1",
      },
      body: JSON.stringify({ actionName: "create-task", input: { title: "Ship it" } }),
    });

    await expect(readDirectActionEnvelope(request)).resolves.toEqual({
      capability: CAPABILITY,
      actionName: "create-task",
      input: { title: "Ship it" },
      idempotencyKey: "direct-create-1",
    });
  });

  it("HTTP-F-001 refuses missing auth, unknown fields, malformed names, and oversized bodies", async () => {
    const cases = [
      new Request("https://demo.convex.site/demo/action", {
        method: "POST",
        body: JSON.stringify({ actionName: "list-tasks", input: {} }),
      }),
      new Request("https://demo.convex.site/demo/action", {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: JSON.stringify({ actionName: "../admin", input: {} }),
      }),
      new Request("https://demo.convex.site/demo/action", {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: JSON.stringify({ actionName: "list-tasks", input: {}, scopeKey: "demo:admin" }),
      }),
      new Request("https://demo.convex.site/demo/action", {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: JSON.stringify({ actionName: "create-task", input: { title: "x".repeat(70_000) } }),
      }),
    ];

    for (const request of cases) {
      await expect(readDirectActionEnvelope(request)).rejects.toThrow("Direct action request refused");
    }
  });

  it("HTTP-I-001 requires an idempotency key for mutating actions", async () => {
    const request = new Request("https://demo.convex.site/demo/action", {
      method: "POST",
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: JSON.stringify({ actionName: "create-task", input: { title: "Once" } }),
    });

    await expect(readDirectActionEnvelope(request)).rejects.toThrow("Direct action request refused");
  });
});
