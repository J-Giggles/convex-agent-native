import {
  executeRegisteredAction,
  type InvocationPersistence,
  type InvocationRecord,
} from "@giggabit/agent-native-convex/action";
import { resolveActionScope } from "@giggabit/agent-native-convex/contracts";
import { describe, expect, it } from "vitest";

import {
  createTaskActionCatalog,
  taskActionDefinitions,
  type Task,
  type TaskStore,
} from "./task-actions.js";

class MemoryInvocations implements InvocationPersistence {
  private readonly records = new Map<string, InvocationRecord>();
  private sequence = 0;

  async claimInvocation(input: Parameters<InvocationPersistence["claimInvocation"]>[0]) {
    const key = `${input.scopeKey}:${input.actionName}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) {
      const same =
        existing.actorId === input.actorId &&
        existing.requestFingerprint === input.requestFingerprint &&
        existing.caller === input.caller;
      return {
        outcome: same ? (existing.status === "running" ? "in_flight" : "replay") : "conflict",
        invocation: existing,
      } as const;
    }
    const now = Date.now();
    const invocation: InvocationRecord = {
      id: `inv-${++this.sequence}`,
      ...input,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, invocation);
    return { outcome: "claimed" as const, invocation };
  }

  async completeInvocation(input: Parameters<InvocationPersistence["completeInvocation"]>[0]) {
    const record = [...this.records.values()].find(({ id }) => id === input.invocationId)!;
    Object.assign(record, { status: "completed", result: input.result, updatedAt: Date.now() });
    return record;
  }

  async failInvocation(input: Parameters<InvocationPersistence["failInvocation"]>[0]) {
    const record = [...this.records.values()].find(({ id }) => id === input.invocationId)!;
    Object.assign(record, {
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: Date.now(),
    });
    return record;
  }

  async getInvocation(input: Parameters<InvocationPersistence["getInvocation"]>[0]) {
    return (
      [...this.records.values()].find(
        ({ id, scopeKey }) => id === input.invocationId && scopeKey === input.scopeKey,
      ) ?? null
    );
  }
}

class MemoryTasks implements TaskStore {
  readonly scopeKey = "demo:test";
  readonly tasks: Task[] = [];
  writes = 0;

  async list(includeDone: boolean) {
    return this.tasks.filter(({ done }) => includeDone || !done);
  }
  async create(title: string) {
    this.writes += 1;
    const task = {
      id: `task-${this.tasks.length + 1}`,
      title,
      done: false,
      sortOrder: this.tasks.length,
      createdAt: 1,
      updatedAt: 1,
    };
    this.tasks.push(task);
    return task;
  }
  async update(taskId: string, patch: { title?: string; done?: boolean }) {
    const task = this.tasks.find(({ id }) => id === taskId);
    if (!task) throw new Error("Task not found");
    this.writes += 1;
    Object.assign(task, patch, { updatedAt: task.updatedAt + 1 });
    return task;
  }
  async delete(taskId: string) {
    const index = this.tasks.findIndex(({ id }) => id === taskId);
    if (index < 0) throw new Error("Task not found");
    this.writes += 1;
    this.tasks.splice(index, 1);
  }
}

const scope = resolveActionScope({
  scopeKey: "demo:test",
  subjectId: "anonymous:test",
  organizationId: "demo:test",
});

function harness() {
  const store = new MemoryTasks();
  const catalog = createTaskActionCatalog(store);
  const persistence = new MemoryInvocations();
  const invoke = (
    actionName: string,
    input: unknown,
    options: { key?: string; caller?: "frontend" | "tool"; approved?: boolean } = {},
  ) =>
    executeRegisteredAction(
      catalog.registry,
      persistence,
      {
        actionName,
        input,
        caller: options.caller ?? "frontend",
        scope,
        executionContext: { taskStore: store },
        ...(options.key ? { idempotencyKey: options.key } : {}),
        ...(options.approved ? { approvedToolCallKey: "approved" } : {}),
      },
      options.approved
        ? {
            approvalVerifier: { verifyAndConsume: async () => true },
          }
        : {},
    );
  return { catalog, invoke, store };
}

describe("shared Builder-style task actions", () => {
  it("TSK-N-001 creates, lists, edits, completes, reopens, and deletes a task", async () => {
    const { invoke } = harness();
    const created = await invoke("create-task", { title: "Make the demo" }, { key: "create-1" });
    expect(created.result).toMatchObject({ title: "Make the demo", done: false });
    const taskId = (created.result as Task).id;
    await expect(invoke("list-tasks", { includeDone: false })).resolves.toMatchObject({
      result: { tasks: [{ id: taskId, title: "Make the demo", done: false }] },
    });
    await expect(
      invoke("update-task", { taskId, title: "Make my demo", done: true }, { key: "update-1" }),
    ).resolves.toMatchObject({ result: { title: "Make my demo", done: true } });
    await expect(invoke("list-tasks", { includeDone: false })).resolves.toMatchObject({
      result: { tasks: [], hasCompletedTasks: true },
    });
    await invoke("update-task", { taskId, done: false }, { key: "update-2" });
    await expect(invoke("delete-task", { taskId }, { key: "delete-1" })).resolves.toMatchObject({
      result: { ok: true },
    });
  });

  it("TSK-F-001 refuses blank titles, no-op patches, unknown tasks, and unapproved agent deletion", async () => {
    const { invoke } = harness();
    await expect(invoke("create-task", { title: "" }, { key: "bad-create" })).rejects.toMatchObject(
      { code: "ACTION_INPUT_INVALID" },
    );
    const created = await invoke("create-task", { title: "Keep" }, { key: "create" });
    const taskId = (created.result as Task).id;
    await expect(invoke("update-task", { taskId }, { key: "noop" })).rejects.toThrow(
      "Provide at least one",
    );
    await expect(
      invoke("update-task", { taskId: "missing", done: true }, { key: "missing" }),
    ).rejects.toThrow("Task not found");
    await expect(
      invoke("delete-task", { taskId }, { key: "agent-delete", caller: "tool" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("TSK-I-001 replays a successful idempotency key without duplicating the write", async () => {
    const { invoke, store } = harness();
    const first = await invoke("create-task", { title: "Once" }, { key: "same" });
    const replay = await invoke("create-task", { title: "Once" }, { key: "same" });
    expect(first.result).toMatchObject({ id: "task-1", title: "Once" });
    expect(replay).toMatchObject({ replayed: true, result: { taskId: "task-1", done: false } });
    expect(store.tasks).toHaveLength(1);
    expect(store.writes).toBe(1);
  });

  it("ACT-N-001 exposes the exact registered definition objects to every surface adapter", () => {
    const { catalog } = harness();
    const otherCatalog = createTaskActionCatalog(new MemoryTasks());
    expect(catalog.definitions).toBe(taskActionDefinitions);
    expect(otherCatalog.definitions).toBe(taskActionDefinitions);
    for (const [name, definition] of Object.entries(catalog.definitions)) {
      expect(catalog.registry.get(name).definition).toBe(definition);
      expect(otherCatalog.registry.get(name).definition).toBe(definition);
    }
  });

  it("ACT-F-001 rejects unknown actions and invalid input before touching the store", async () => {
    const { invoke, store } = harness();
    await expect(invoke("missing-action", {}, { key: "missing" })).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
    });
    await expect(invoke("create-task", { title: 42 }, { key: "invalid" })).rejects.toMatchObject({
      code: "ACTION_INPUT_INVALID",
    });
    expect(store.writes).toBe(0);
  });

  it("ACT-I-001 binds authorization to the host-resolved store scope", async () => {
    const store = new MemoryTasks();
    Object.defineProperty(store, "scopeKey", { value: "demo:other" });
    const catalog = createTaskActionCatalog(store);
    await expect(
      executeRegisteredAction(catalog.registry, new MemoryInvocations(), {
        actionName: "create-task",
        input: { title: "Escape" },
        caller: "frontend",
        scope,
        idempotencyKey: "escape",
      }),
    ).rejects.toMatchObject({ code: "ACTION_NOT_AUTHORIZED" });
    expect(store.writes).toBe(0);
  });
});
