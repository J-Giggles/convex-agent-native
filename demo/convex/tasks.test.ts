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
  "./quotas.ts": () => import("./quotas.js"),
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
    now: Date.now(),
  });
  return { capability, scopeKey: `demo:${capability.publicId}` };
}

describe("Convex task persistence", () => {
  it("TSK-N-001 persists seeded and created tasks into the reactive scoped query", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);
    await expect(t.query(api.tasks.list, { capability: capability.token })).resolves.toMatchObject([
      { title: "Record the demo", done: false },
      { title: "Get groceries", done: false },
    ]);
    await t.mutation(internal.tasks.createForAction, {
      scopeKey,
      title: "Make my demo",
      operationKey: "create-task:task-1",
    });
    await expect(t.query(api.tasks.list, { capability: capability.token })).resolves.toHaveLength(
      3,
    );
  });

  it("TSK-F-001 hides task existence across anonymous session scopes", async () => {
    const t = convexTest(schema, modules);
    const first = await issue(t, 1);
    const second = await issue(t, 41);
    const task = await t.mutation(internal.tasks.createForAction, {
      scopeKey: first.scopeKey,
      title: "Private",
      operationKey: "create-task:private",
    });
    await expect(
      t.mutation(internal.tasks.updateForAction, {
        scopeKey: second.scopeKey,
        taskId: task.id as Id<"tasks">,
        done: true,
        operationKey: "update-task:escape",
      }),
    ).rejects.toThrow("Task not found");
  });

  it("TSK-I-001 makes a repeated domain operation idempotent", async () => {
    const t = convexTest(schema, modules);
    const { capability, scopeKey } = await issue(t, 1);
    const input = { scopeKey, title: "Exactly once", operationKey: "create-task:once" };
    const first = await t.mutation(internal.tasks.createForAction, input);
    const replay = await t.mutation(internal.tasks.createForAction, input);
    expect(replay.id).toBe(first.id);
    const tasks = await t.query(api.tasks.list, {
      capability: capability.token,
      includeDone: true,
    });
    expect(tasks.filter(({ title }: { title: string }) => title === "Exactly once")).toHaveLength(
      1,
    );
  });

  it("TSK-F-002 refuses creation when a session reaches its durable task cap", async () => {
    const t = convexTest(schema, modules);
    const { scopeKey } = await issue(t, 1);
    await t.run(async (ctx) => {
      for (let index = 2; index < 200; index += 1) {
        await ctx.db.insert("tasks", {
          scopeKey,
          title: `Bounded ${index}`,
          done: false,
          sortOrder: index,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    await expect(
      t.mutation(internal.tasks.createForAction, {
        scopeKey,
        title: "One too many",
        operationKey: "create-task:over-cap",
      }),
    ).rejects.toThrow("Task limit reached");
  });
});
