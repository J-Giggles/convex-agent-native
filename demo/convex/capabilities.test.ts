import { describe, expect, it } from "vitest";

import {
  capabilityDigest,
  createCapability,
  parseCapability,
  resolveCapabilityScope,
} from "./capabilities.js";

describe("anonymous demo capabilities", () => {
  it("SES-N-001 issues an opaque capability that resolves to one host-derived scope", async () => {
    const capability = createCapability(
      new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)),
    );
    const parsed = parseCapability(capability.token);

    expect(parsed).toEqual({ publicId: capability.publicId, secret: capability.secret });
    expect(capability.token).not.toContain("scope:");
    expect(
      resolveCapabilityScope({
        publicId: capability.publicId,
        secretDigest: await capabilityDigest(capability.secret),
      }),
    ).toMatchObject({
      scopeKey: `demo:${capability.publicId}`,
      subjectId: `anonymous:${capability.publicId}`,
    });
  });

  it("SES-F-001 refuses malformed or non-canonical capabilities", () => {
    for (const token of ["", "demo", "demo_abc", "demo_abc.secret.extra", "scope:chosen.secret"]) {
      expect(() => parseCapability(token)).toThrow("Invalid demo capability");
    }
  });

  it("SES-I-001 stores a digest rather than the bearer secret", async () => {
    expect(await capabilityDigest("secret")).toBe(
      "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
    );
  });
});
