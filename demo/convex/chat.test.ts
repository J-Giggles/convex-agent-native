import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { capabilityDigest, createCapability } from "./capabilities.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api.js"),
  "./_generated/dataModel.ts": () => import("./_generated/dataModel.js"),
  "./_generated/server.ts": () => import("./_generated/server.js"),
  "./capabilities.ts": () => import("./capabilities.js"),
  "./chat.ts": () => import("./chat.js"),
  "./chatAction.ts": () => import("./chatAction.js"),
  "./quotas.ts": () => import("./quotas.js"),
  "./receipts.ts": () => import("./receipts.js"),
  "./sessions.ts": () => import("./sessions.js"),
  "./tasks.ts": () => import("./tasks.js"),
};

async function issue(t: ReturnType<typeof convexTest>, offset: number) {
  const capability = createCapability(
    new Uint8Array(Array.from({ length: 32 }, (_, index) => (index + offset) % 256)),
  );
  await t.mutation(internal.sessions.issueForTest, {
    publicId: capability.publicId,
    secretDigest: await capabilityDigest(capability.secret),
    provenanceDigest: offset.toString(16).padStart(64, "0"),
    now: 1_800_000_000_000,
  });
  return { capability, scopeKey: `demo:${capability.publicId}` };
}

describe("Convex-backed deterministic chat", () => {
  it("CHT-N-001 persists bounded messages behind the session-scoped reactive query", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);

    await t.mutation(internal.chat.append, {
      scopeKey,
      role: "user",
      content: `  ${"a".repeat(600)}  `,
      now: 1_800_000_000_001,
    });

    await expect(t.query(api.chat.list, { capability: capability.token })).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "a".repeat(500) }),
    ]);

    await expect(
      t.action(api.chatAction.send, { capability: capability.token, prompt: "list tasks" }),
    ).resolves.toMatchObject({
      status: "completed",
      actionName: "list-tasks",
      replayed: false,
      message: expect.stringContaining("Record the demo"),
    });
  });

  it("CHT-F-001 refuses unsupported chat without invoking or mutating a task action", async () => {
    const t = convexTest(schema, modules);
    const { capability } = await issue(t, 2);
    const before = await t.query(api.tasks.list, { capability: capability.token, includeDone: true });

    await expect(
      t.action(api.chatAction.send, { capability: capability.token, prompt: "email my manager" }),
    ).resolves.toMatchObject({ status: "refused", code: "unsupported" });

    await expect(t.query(api.tasks.list, { capability: capability.token, includeDone: true })).resolves.toEqual(before);
    await expect(t.query(api.receipts.list, { capability: capability.token })).resolves.toEqual([]);
    await expect(t.query(api.chat.list, { capability: capability.token })).resolves.toMatchObject([
      { role: "user", content: "email my manager" },
      { role: "assistant", content: expect.stringContaining("list, add, rename") },
    ]);
  });

  it("CHT-I-001 lets exactly one concurrent confirmation claim a durable pending delete", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 3);
    const [task] = await t.query(api.tasks.list, {
      capability: capability.token,
      includeDone: true,
    });
    await t.mutation(internal.chat.setPendingDelete, {
      scopeKey,
      taskId: task!.id as Id<"tasks">,
      taskTitle: task!.title,
      now: 1_800_000_000_001,
    });

    const claims = await Promise.all([
      t.mutation(internal.chat.claimPendingDelete, { scopeKey }),
      t.mutation(internal.chat.claimPendingDelete, { scopeKey }),
    ]);

    expect(claims.filter((claim: unknown) => claim !== null)).toEqual([
      { taskId: task!.id, taskTitle: task!.title },
    ]);
    expect(claims.filter((claim: unknown) => claim === null)).toHaveLength(1);
  });

  it("CHT-I-001 clears chat history and destructive state when the demo session resets", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 4);
    const [task] = await t.query(api.tasks.list, {
      capability: capability.token,
      includeDone: true,
    });
    await t.mutation(internal.chat.append, {
      scopeKey,
      role: "user",
      content: "delete record the demo",
      now: 1_800_000_000_001,
    });
    await t.mutation(internal.chat.setPendingDelete, {
      scopeKey,
      taskId: task!.id as Id<"tasks">,
      taskTitle: task!.title,
      now: 1_800_000_000_001,
    });

    await t.mutation(api.sessions.reset, { capability: capability.token });

    await expect(t.query(api.chat.list, { capability: capability.token })).resolves.toEqual([]);
    await expect(
      t.mutation(internal.chat.claimPendingDelete, { scopeKey }),
    ).resolves.toBeNull();
  });

  it("CHT-I-001 consumes the chat quota exactly once even when a shared action runs", async () => {
    const t = convexTest(schema, modules);
    const { capability } = await issue(t, 5);
    const send = () =>
      t.action(api.chatAction.send, { capability: capability.token, prompt: "list tasks" });

    for (let index = 0; index < 8; index += 1) {
      await expect(send()).resolves.toMatchObject({
        status: "completed",
        actionName: "list-tasks",
      });
    }
    await expect(send()).rejects.toThrow("Demo quota exceeded");
  });
});
