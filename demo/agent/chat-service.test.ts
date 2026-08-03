import { describe, expect, it, vi } from "vitest";

import { handleDemoChat, type DemoChatDependencies } from "./chat-service.js";

function dependencies(): DemoChatDependencies & { invoke: ReturnType<typeof vi.fn> } {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  let pending: { taskId: string; taskTitle: string } | null = null;
  return {
    listTasks: async () => [
      { id: "task-1", title: "Make my demo", done: false, sortOrder: 0, createdAt: 1, updatedAt: 1 },
    ],
    invoke: vi.fn(async () => ({ invocationId: "inv-1", replayed: false, result: { ok: true } })),
    append: async (role, content) => void messages.push({ role, content }),
    claimPendingDelete: async () => {
      const claimed = pending;
      pending = null;
      return claimed;
    },
    setPendingDelete: async (value) => void (pending = value),
    nextIdempotencyKey: () => "chat-call-1",
  };
}

describe("deterministic chat orchestration", () => {
  it("CHT-N-001 invokes the shared action dispatcher and returns a bounded receipt", async () => {
    const deps = dependencies();
    await expect(handleDemoChat("complete make my demo", deps)).resolves.toMatchObject({
      status: "completed",
      invocationId: "inv-1",
      actionName: "update-task",
    });
    expect(deps.invoke).toHaveBeenCalledWith(
      "update-task",
      { taskId: "task-1", done: true },
      { approved: false, idempotencyKey: "chat-call-1" },
    );
  });

  it("CHT-F-001 refuses unsupported and destructive-unconfirmed prompts without mutation", async () => {
    const deps = dependencies();
    await expect(handleDemoChat("email my manager", deps)).resolves.toMatchObject({
      status: "refused",
      code: "unsupported",
    });
    await expect(handleDemoChat("delete make my demo", deps)).resolves.toMatchObject({
      status: "confirmation-required",
      actionName: "delete-task",
    });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("CHT-I-001 consumes a pending confirmation exactly once through the same dispatcher", async () => {
    const deps = dependencies();
    await handleDemoChat("delete make my demo", deps);
    await expect(handleDemoChat("confirm delete", deps)).resolves.toMatchObject({
      status: "completed",
      actionName: "delete-task",
      invocationId: "inv-1",
    });
    expect(deps.invoke).toHaveBeenCalledWith(
      "delete-task",
      { taskId: "task-1" },
      { approved: true, idempotencyKey: "chat-call-1" },
    );
    await expect(handleDemoChat("confirm delete", deps)).resolves.toMatchObject({
      status: "refused",
      code: "confirmation-missing",
    });
    expect(deps.invoke).toHaveBeenCalledTimes(1);
  });
});
