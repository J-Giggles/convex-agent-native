import { describe, expect, it } from "vitest";

import { resolveBootstrapRequest } from "./bootstrap.js";

describe("public demo bootstrap policy", () => {
  it("SES-N-001 accepts the canonical Pages origin with trusted forwarding provenance", () => {
    const request = new Request("https://demo.convex.site/demo/session", {
      method: "POST",
      headers: {
        origin: "https://j-giggles.github.io",
        "x-forwarded-for": "198.51.100.7, 100.64.0.2",
      },
    });
    expect(resolveBootstrapRequest(request)).toEqual({
      allowOrigin: "https://j-giggles.github.io",
      provenance: "forwarded:100.64.0.2",
    });
  });

  it("SES-F-001 refuses unknown origins and missing trusted provenance", () => {
    for (const headers of [
      new Headers({ origin: "https://evil.example", "x-forwarded-for": "100.64.0.2" }),
      new Headers({ origin: "https://j-giggles.github.io" }),
    ]) {
      expect(() =>
        resolveBootstrapRequest(
          new Request("https://demo.convex.site/demo/session", { method: "POST", headers }),
        ),
      ).toThrow("Demo bootstrap unavailable");
    }
  });

  it("SES-I-001 never accepts caller-selected scope or capability material", () => {
    const request = new Request("https://demo.convex.site/demo/session?scope=admin", {
      method: "POST",
      headers: {
        origin: "https://j-giggles.github.io",
        "x-forwarded-for": "scope:chosen, 100.64.0.3",
        authorization: "Bearer attacker-selected",
      },
    });
    expect(resolveBootstrapRequest(request)).toEqual({
      allowOrigin: "https://j-giggles.github.io",
      provenance: "forwarded:100.64.0.3",
    });
  });
});
