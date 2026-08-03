import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { capabilityDigest, createCapability } from "./capabilities.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server.js"),
  "./capabilities.ts": () => import("./capabilities.js"),
  "./quotas.ts": () => import("./quotas.js"),
  "./sessions.ts": () => import("./sessions.js"),
};

function fixedCapability(offset: number) {
  return createCapability(
    new Uint8Array(Array.from({ length: 32 }, (_, index) => (index + offset) % 256)),
  );
}

describe("durable anonymous demo sessions", () => {
  it("SES-N-001 issues, resolves, and resets only one seeded session", async () => {
    const t = convexTest(schema, modules);
    const capability = fixedCapability(1);
    const now = Date.now();
    await t.mutation(internal.sessions.issueForTest, {
      publicId: capability.publicId,
      secretDigest: await capabilityDigest(capability.secret),
      provenanceDigest: "a".repeat(64),
      now,
    });

    await expect(
      t.query(api.sessions.get, { capability: capability.token }),
    ).resolves.toMatchObject({
      publicId: capability.publicId,
      scopeKey: `demo:${capability.publicId}`,
      resetVersion: 0,
    });
    await expect(t.mutation(api.sessions.reset, { capability: capability.token })).resolves.toEqual(
      { resetVersion: 1 },
    );
    await expect(
      t.query(api.sessions.get, { capability: capability.token }),
    ).resolves.toMatchObject({
      scopeKey: `demo:${capability.publicId}:r1`,
      resetVersion: 1,
    });
  });

  it("SES-F-001 refuses invalid, expired, and cross-session capabilities without an existence signal", async () => {
    const t = convexTest(schema, modules);
    const first = fixedCapability(1);
    const second = fixedCapability(41);
    const now = Date.now();
    await t.mutation(internal.sessions.issueForTest, {
      publicId: first.publicId,
      secretDigest: await capabilityDigest(first.secret),
      provenanceDigest: "b".repeat(64),
      now: now - 86_400_001,
    });

    for (const capability of [second.token, `${first.token.slice(0, -1)}x`]) {
      await expect(t.query(api.sessions.get, { capability })).rejects.toThrow(
        "Demo session unavailable",
      );
    }
    await expect(t.query(api.sessions.get, { capability: first.token })).rejects.toThrow(
      "Demo session unavailable",
    );
  });

  it("SES-I-001 never persists the bearer capability or plaintext secret", async () => {
    const t = convexTest(schema, modules);
    const capability = fixedCapability(7);
    await t.mutation(internal.sessions.issueForTest, {
      publicId: capability.publicId,
      secretDigest: await capabilityDigest(capability.secret),
      provenanceDigest: "c".repeat(64),
      now: 1_800_000_000_000,
    });

    const serialized = await t.run(async (ctx) =>
      JSON.stringify(await ctx.db.query("demoSessions").collect()),
    );
    expect(serialized).not.toContain(capability.token);
    expect(serialized).not.toContain(capability.secret);
    expect(serialized).toContain(await capabilityDigest(capability.secret));
  });

  it("SES-I-002 rotates durable action state without rotating the reset quota identity", async () => {
    const t = convexTest(schema, modules);
    const capability = fixedCapability(9);
    await t.mutation(internal.sessions.issueForTest, {
      publicId: capability.publicId,
      secretDigest: await capabilityDigest(capability.secret),
      provenanceDigest: "9".repeat(64),
      now: Date.now(),
    });

    for (let resetVersion = 1; resetVersion <= 3; resetVersion += 1) {
      await expect(
        t.mutation(api.sessions.reset, { capability: capability.token }),
      ).resolves.toEqual({
        resetVersion,
      });
    }
    await expect(t.mutation(api.sessions.reset, { capability: capability.token })).rejects.toThrow(
      "Demo quota exceeded",
    );
    await expect(
      t.query(api.sessions.get, { capability: capability.token }),
    ).resolves.toMatchObject({
      scopeKey: `demo:${capability.publicId}:r3`,
      resetVersion: 3,
    });
  });
});

describe("durable public quotas", () => {
  it("QTA-N-001 atomically consumes allowed session and deployment budget", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.quotas.consume, {
        scopeKey: "demo:session-a",
        provenanceDigest: "d".repeat(64),
        operation: "chat",
        units: 1,
        now: 1_800_000_000_000,
      }),
    ).resolves.toEqual({ remaining: 7 });
  });

  it("QTA-F-001 rejects excess before another unit is consumed", async () => {
    const t = convexTest(schema, modules);
    const request = {
      scopeKey: "demo:session-a",
      provenanceDigest: "e".repeat(64),
      operation: "chat" as const,
      units: 1,
      now: 1_800_000_000_000,
    };
    for (let index = 0; index < 8; index += 1) await t.mutation(internal.quotas.consume, request);
    await expect(t.mutation(internal.quotas.consume, request)).rejects.toThrow(
      "Demo quota exceeded",
    );
  });

  it("QTA-I-001 cannot overspend under concurrent requests", async () => {
    const t = convexTest(schema, modules);
    const request = {
      scopeKey: "demo:session-race",
      provenanceDigest: "f".repeat(64),
      operation: "chat" as const,
      units: 1,
      now: 1_800_000_000_000,
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => t.mutation(internal.quotas.consume, request)),
    );
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(8);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(4);
  });
});
