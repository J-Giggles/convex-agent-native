import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { capabilityDigest, createCapability } from "./capabilities.js";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api.js"),
  "./_generated/dataModel.ts": () => import("./_generated/dataModel.js"),
  "./_generated/server.ts": () => import("./_generated/server.js"),
  "./capabilities.ts": () => import("./capabilities.js"),
  "./quotas.ts": () => import("./quotas.js"),
  "./receipts.ts": () => import("./receipts.js"),
  "./sessions.ts": () => import("./sessions.js"),
};

async function issue(t: ReturnType<typeof convexTest>, offset: number) {
  const capability = createCapability(
    new Uint8Array(Array.from({ length: 32 }, (_, index) => (index + offset) % 256)),
  );
  await t.mutation(internal.sessions.issueForTest, {
    publicId: capability.publicId,
    secretDigest: await capabilityDigest(capability.secret),
    provenanceDigest: offset.toString(16).padStart(64, "0"),
    now: Date.now(),
  });
  return { capability, scopeKey: `demo:${capability.publicId}` };
}

describe("bounded durable receipt projection", () => {
  it("RCP-N-001 reactively exposes bounded lifecycle metadata for a scoped caller", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);
    await t.mutation(internal.receipts.project, {
      scopeKey,
      invocationId: "inv-1",
      actionName: "create-task",
      caller: "frontend",
      status: "completed",
      replayed: false,
      createdAt: 10,
      updatedAt: 11,
    });
    await expect(t.query(api.receipts.list, { capability: capability.token })).resolves.toEqual([
      {
        invocationId: "inv-1",
        actionName: "create-task",
        caller: "frontend",
        status: "completed",
        replayed: false,
        createdAt: 10,
        updatedAt: 11,
      },
    ]);
  });

  it("RCP-F-001 returns no cross-session existence signal", async () => {
    const t = convexTest(schema, modules);
    const first = await issue(t, 1);
    const second = await issue(t, 41);
    await t.mutation(internal.receipts.project, {
      scopeKey: first.scopeKey,
      invocationId: "inv-private",
      actionName: "update-task",
      caller: "mcp",
      status: "failed",
      replayed: false,
      createdAt: 10,
      updatedAt: 11,
    });
    await expect(
      t.query(api.receipts.list, { capability: second.capability.token }),
    ).resolves.toEqual([]);
  });

  it("RCP-I-001 never regresses terminal state or projects task content and credentials", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);
    const base = {
      scopeKey,
      invocationId: "inv-final",
      actionName: "delete-task",
      caller: "tool" as const,
      replayed: false,
      createdAt: 10,
      updatedAt: 11,
    };
    await t.mutation(internal.receipts.project, { ...base, status: "completed" });
    await expect(
      t.mutation(internal.receipts.project, { ...base, status: "running", updatedAt: 12 }),
    ).rejects.toThrow("Receipt is already terminal");
    const serialized = JSON.stringify(
      await t.query(api.receipts.list, { capability: capability.token }),
    );
    expect(serialized).not.toMatch(/title|prompt|capability|token|idempotency/iu);
  });

  it("RCP-I-002 records replay monotonically on an existing terminal receipt", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);
    const base = {
      scopeKey,
      invocationId: "inv-replayed",
      actionName: "create-task",
      caller: "http" as const,
      status: "completed" as const,
      createdAt: 10,
    };
    await t.mutation(internal.receipts.project, { ...base, replayed: false, updatedAt: 11 });
    await t.mutation(internal.receipts.project, { ...base, replayed: true, updatedAt: 12 });
    await t.mutation(internal.receipts.project, { ...base, replayed: false, updatedAt: 13 });

    await expect(t.query(api.receipts.list, { capability: capability.token })).resolves.toEqual([
      expect.objectContaining({ invocationId: "inv-replayed", replayed: true, updatedAt: 13 }),
    ]);
  });
});
