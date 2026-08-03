import { describe, expect, it, vi } from "vitest";

import {
  connectConvexDemoClient,
  type ConvexTransport,
  type StorageLike,
} from "./convexDemoClient.js";

const CAPABILITY = "demo_AAECAwQFBgcICQoL.DA0ODxAREhMUFRYXGBkaGxwdHh8";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

class FakeTransport implements ConvexTransport {
  readonly actions: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly watches: Array<{
    name: string;
    args: Record<string, unknown>;
    update: (value: unknown) => void;
    error: (error: unknown) => void;
    active: boolean;
  }> = [];

  watchQuery(
    name: string,
    args: Record<string, unknown>,
    update: (value: unknown) => void,
    error: (error: unknown) => void,
  ) {
    const watch = { name, args, update, error, active: true };
    this.watches.push(watch);
    return () => {
      watch.active = false;
    };
  }

  async action(name: string, args: Record<string, unknown>) {
    this.actions.push({ name, args });
  }

  async mutation(name: string, args: Record<string, unknown>) {
    this.mutations.push({ name, args });
  }

  close() {}

  emit(name: string, value: unknown) {
    const match = [...this.watches].reverse().find((watch) => watch.name === name && watch.active);
    if (!match) throw new Error(`No active watch for ${name}`);
    match.update(value);
  }
}

describe("Convex browser adapter", () => {
  it("bootstraps outside the URL, subscribes reactively, and invokes the shared action surface", async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ capability: CAPABILITY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = await connectConvexDemoClient({
      convexUrl: "https://example.convex.cloud",
      siteUrl: "https://example.convex.site/",
      storage,
      fetcher,
      transport,
      idempotencyKey: () => "ui-key-1",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://example.convex.site/demo/session",
      expect.objectContaining({ method: "POST", cache: "no-store", referrerPolicy: "no-referrer" }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(CAPABILITY);
    expect(storage.getItem("convex-agent-native.demo-capability.v1")).toBe(CAPABILITY);
    expect(transport.watches.map(({ name }) => name)).toEqual(["tasks:list", "receipts:list", "chat:list"]);

    transport.emit("tasks:list", [
      { id: "task-1", title: "Reactive task", done: false, ignored: "field" },
    ]);
    transport.emit(
      "receipts:list",
      Array.from({ length: 28 }, (_, index) => ({
        invocationId: `inv-${index + 1}`,
        actionName: "create-task",
        caller: "frontend",
        status: "completed",
        createdAt: index,
        updatedAt: index,
      })),
    );
    expect(client.getSnapshot()).toMatchObject({
      loading: false,
      tasks: [{ id: "task-1", title: "Reactive task", done: false }],
    });
    expect(client.getSnapshot().receipts).toHaveLength(20);

    await client.createTask("Use the same action");
    await client.updateTask("task-1", { done: true });
    await client.deleteTask("task-1");
    await client.sendChat("list tasks");
    expect(transport.actions).toEqual([
      {
        name: "actions:invoke",
        args: {
          capability: CAPABILITY,
          actionName: "create-task",
          input: { title: "Use the same action" },
          idempotencyKey: "ui-key-1",
        },
      },
      {
        name: "actions:invoke",
        args: {
          capability: CAPABILITY,
          actionName: "update-task",
          input: { taskId: "task-1", done: true },
          idempotencyKey: "ui-key-1",
        },
      },
      {
        name: "actions:invoke",
        args: {
          capability: CAPABILITY,
          actionName: "delete-task",
          input: { taskId: "task-1" },
          idempotencyKey: "ui-key-1",
        },
      },
      {
        name: "chatAction:send",
        args: { capability: CAPABILITY, prompt: "list tasks" },
      },
    ]);

    client.setIncludeDone(true);
    expect(transport.watches.filter(({ name, active }) => name === "tasks:list" && active)).toMatchObject([
      { args: { capability: CAPABILITY, includeDone: true } },
    ]);
    await client.reset();
    expect(transport.mutations).toEqual([
      { name: "sessions:reset", args: { capability: CAPABILITY } },
    ]);
  });

  it("reuses only canonical stored capabilities and fails closed on an unsafe bootstrap response", async () => {
    const storage = new MemoryStorage();
    storage.setItem("convex-agent-native.demo-capability.v1", "not-a-capability");
    const transport = new FakeTransport();
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: "database password secret" }), { status: 503 }),
    );

    await expect(
      connectConvexDemoClient({
        convexUrl: "https://example.convex.cloud",
        siteUrl: "https://example.convex.site",
        storage,
        fetcher,
        transport,
      }),
    ).rejects.toThrow("The public demo could not start. Please try again later.");
    expect(storage.getItem("convex-agent-native.demo-capability.v1")).toBeNull();
  });

  it("refuses deployment URLs with credentials, paths, queries, or non-HTTPS public origins", async () => {
    const fetcher = vi.fn();
    for (const convexUrl of [
      "http://example.convex.cloud",
      "https://user:password@example.convex.cloud",
      "https://example.convex.cloud/path",
      "https://example.convex.cloud?deployment=other",
    ]) {
      await expect(
        connectConvexDemoClient({
          convexUrl,
          siteUrl: "https://example.convex.site",
          storage: new MemoryStorage(),
          fetcher,
          transport: new FakeTransport(),
        }),
      ).rejects.toThrow("VITE_CONVEX_URL");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
