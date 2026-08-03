import { describe, expect, it } from "vitest";

import { resolveBootstrapRequest } from "./bootstrap.js";

describe("public demo bootstrap policy", () => {
  it("SES-N-001 accepts the canonical Pages origin with a server-owned quota identity", () => {
    const request = new Request("https://demo.convex.site/demo/session", {
      method: "POST",
      headers: {
        origin: "https://j-giggles.github.io",
        "x-forwarded-for": "198.51.100.7, 100.64.0.2",
      },
    });
    expect(resolveBootstrapRequest(request)).toEqual({
      allowOrigin: "https://j-giggles.github.io",
      provenance: "public-demo-bootstrap:v1",
    });
  });

  it("SES-F-001 refuses unknown and missing origins", () => {
    for (const headers of [new Headers({ origin: "https://evil.example" }), new Headers()]) {
      expect(() =>
        resolveBootstrapRequest(
          new Request("https://demo.convex.site/demo/session", { method: "POST", headers }),
        ),
      ).toThrow("Demo bootstrap unavailable");
    }
  });

  it("SES-I-001 never lets headers, query input, or capability material select the quota bucket", () => {
    const resolve = (forwarded: string, suffix: string) =>
      resolveBootstrapRequest(
        new Request(`https://demo.convex.site/demo/session?scope=${suffix}`, {
          method: "POST",
          headers: {
            origin: "https://j-giggles.github.io",
            "x-forwarded-for": forwarded,
            authorization: `Bearer ${suffix}`,
          },
        }),
      );
    expect(resolve("198.51.100.1", "admin")).toEqual(resolve("203.0.113.9", "other"));
    expect(resolve("198.51.100.1", "admin").provenance).toBe("public-demo-bootstrap:v1");
  });
});
