import { describe, expect, it } from "vitest";

import { publicHttpFailure } from "./httpErrors.js";

describe("public HTTP error projection", () => {
  it("HTTP-N-002 preserves safe authentication, capacity, and request status classes", () => {
    expect(publicHttpFailure(new Error("Uncaught Error: Demo session unavailable"))).toEqual({
      status: 401,
      code: "unauthorized",
    });
    expect(publicHttpFailure(new Error("Demo quota exceeded"))).toEqual({
      status: 429,
      code: "capacity",
    });
    expect(publicHttpFailure(new Error("Direct action request refused"))).toEqual({
      status: 400,
      code: "invalid_request",
    });
  });

  it("HTTP-F-002 classifies unknown server faults as internal failures", () => {
    expect(publicHttpFailure(new Error("database internals"))).toEqual({
      status: 500,
      code: "internal",
    });
  });

  it("HTTP-I-002 never includes raw error or credential material in the public projection", () => {
    const failure = publicHttpFailure(new Error("Bearer demo_secret database internals"));
    expect(JSON.stringify(failure)).not.toMatch(/Bearer|demo_secret|database/iu);
  });
});
