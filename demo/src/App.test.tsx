// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.js";
import type { AuditReceipt, DemoClient, DemoSnapshot, Task } from "./demoClient.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeDemoClient implements DemoClient {
  private listeners = new Set<() => void>();
  private nextId = 3;
  private snapshot: DemoSnapshot = {
    loading: false,
    includeDone: false,
    tasks: [
      { id: "task-1", title: "Record the demo", done: false },
      { id: "task-2", title: "Get groceries", done: false },
    ],
    receipts: [],
    messages: [],
  };
  private failure: Error | null = null;
  private deferredFailure: Promise<never> | null = null;
  deleteCalls = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  async createTask(title: string) {
    await this.maybeFail();
    const task = { id: `task-${this.nextId++}`, title, done: false };
    this.update([...this.snapshot.tasks, task], "create-task");
  }

  async updateTask(taskId: string, patch: Pick<Partial<Task>, "title" | "done">) {
    await this.maybeFail();
    this.update(
      this.snapshot.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
      "update-task",
    );
  }

  async deleteTask(taskId: string) {
    this.deleteCalls += 1;
    await this.maybeFail();
    this.update(this.snapshot.tasks.filter((task) => task.id !== taskId), "delete-task");
  }

  async sendChat(prompt: string) {
    await this.maybeFail();
    this.snapshot = {
      ...this.snapshot,
      messages: [
        ...this.snapshot.messages,
        { id: `msg-${this.snapshot.messages.length + 1}`, role: "user", content: prompt, createdAt: 1 },
        { id: `msg-${this.snapshot.messages.length + 2}`, role: "assistant", content: "Task added.", createdAt: 2 },
      ],
    };
    this.emit();
  }

  async reset() {
    await this.maybeFail();
    this.nextId = 3;
    this.snapshot = {
      ...this.snapshot,
      tasks: [
        { id: "task-1", title: "Record the demo", done: false },
        { id: "task-2", title: "Get groceries", done: false },
      ],
    };
    this.emit();
  }

  setIncludeDone(includeDone: boolean) {
    this.snapshot = { ...this.snapshot, includeDone };
    this.emit();
  }

  failNextWith(error: Error) {
    this.failure = error;
  }

  deferNextFailure() {
    let reject!: (error: Error) => void;
    this.deferredFailure = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    return (error: Error) => reject(error);
  }

  setSubscriptionError(error: string) {
    this.snapshot = { ...this.snapshot, error };
    this.emit();
  }

  private update(tasks: Task[], actionName: string) {
    const receipt: AuditReceipt = {
      invocationId: `inv-${this.snapshot.receipts.length + 1}`,
      actionName,
      caller: "frontend",
      status: "completed",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
    };
    this.snapshot = { ...this.snapshot, tasks, receipts: [receipt, ...this.snapshot.receipts] };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private async maybeFail() {
    if (this.deferredFailure) {
      const failure = this.deferredFailure;
      this.deferredFailure = null;
      await failure;
    }
    if (!this.failure) return;
    const failure = this.failure;
    this.failure = null;
    throw failure;
  }
}

const roots: Root[] = [];

async function render(client: DemoClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<App client={client} />));
  return container;
}

function button(container: ParentNode, name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function typeTextarea(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("public task workspace", () => {
  it("CHT-UI-N-001 exposes the built-in deterministic agent and its provider seam", async () => {
    const container = await render(new FakeDemoClient());

    expect(container.textContent).toContain("Built-in agent");
    expect(container.textContent).toContain("Deterministic demo mode");
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea[name="agent-prompt"]');
    if (!prompt) throw new Error("Missing agent prompt");
    await typeTextarea(prompt, "add Prepare release notes");
    await click(button(container, "Send to agent"));
    expect(container.textContent).toContain("add Prepare release notes");
    expect(container.textContent).toContain("Task added.");
  });

  it("UI-N-001 creates, edits, completes, reopens, deletes, and resets tasks with visible receipts", async () => {
    const container = await render(new FakeDemoClient());
    expect(container.textContent).toContain("Record the demo");
    expect(container.textContent).toContain("Independent Convex port");
    expect(container.querySelector('a[href="https://www.builder.io/"]')?.textContent).toBe("Builder.io");

    const newTask = container.querySelector<HTMLInputElement>('input[name="new-task"]');
    if (!newTask) throw new Error("Missing new-task input");
    await type(newTask, "Share the port");
    await click(button(container, "Add task"));
    expect(container.textContent).toContain("Share the port");
    expect(newTask.value).toBe("");

    await click(button(container, "Edit Share the port"));
    const editInput = container.querySelector<HTMLInputElement>('input[name="edit-task"]');
    if (!editInput) throw new Error("Missing edit-task input");
    await type(editInput, "Share the live port");
    await click(button(container, "Save edit"));
    expect(container.textContent).toContain("Share the live port");

    await click(button(container, "Complete Share the live port"));
    expect(container.textContent).not.toContain("Share the live port");
    const showCompleted = container.querySelector<HTMLInputElement>('input[name="show-completed"]');
    if (!showCompleted) throw new Error("Missing show-completed control");
    await click(showCompleted);
    expect(container.textContent).toContain("Share the live port");
    await click(button(container, "Reopen Share the live port"));

    await click(button(container, "Delete Share the live port"));
    expect(container.querySelector("dialog[open]")?.textContent).toContain("Delete this task?");
    await click(button(container, "Delete permanently"));
    expect(container.textContent).not.toContain("Share the live port");

    await click(button(container, "Reset demo"));
    expect(container.querySelector("dialog[open]")?.textContent).toContain("Reset this demo?");
    await click(button(container, "Reset tasks"));
    expect(container.textContent).toContain("Record the demo");
    expect(container.textContent).toContain("delete-task");
    expect(container.textContent).toContain("completed");
  });

  it("UI-F-001 refuses invalid input, cancels destructive changes, and bounds untrusted errors", async () => {
    const client = new FakeDemoClient();
    const container = await render(client);

    await click(button(container, "Add task"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Task title is required.");
    expect(container.querySelectorAll(".task-row")).toHaveLength(2);

    await click(button(container, "Delete Record the demo"));
    await click(button(container, "Cancel"));
    expect(client.deleteCalls).toBe(0);
    expect(container.textContent).toContain("Record the demo");

    const rejectDelete = client.deferNextFailure();
    await click(button(container, "Delete Record the demo"));
    await click(button(container, "Delete permanently"));
    expect(container.textContent).not.toContain("Record the demo");
    await act(async () => rejectDelete(new Error(`provider token sk-secret ${"x".repeat(400)}`)));
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toBe("That request could not be completed. Please try again.");
    expect(alert).not.toContain("sk-secret");
    expect(alert.length).toBeLessThanOrEqual(160);
    expect(container.textContent).toContain("Record the demo");

    const subscriptionClient = new FakeDemoClient();
    subscriptionClient.setSubscriptionError(`websocket sk-live ${"y".repeat(400)}`);
    const secondContainer = await render(subscriptionClient);
    const subscriptionAlert = secondContainer.querySelector('[role="alert"]')?.textContent ?? "";
    expect(subscriptionAlert).toBe("That request could not be completed. Please try again.");
    expect(subscriptionAlert).not.toContain("sk-live");
  });

  it("UI-I-001 updates every subscribed view while keeping receipts bounded and capabilities absent", async () => {
    const sharedClient = new FakeDemoClient();
    const first = await render(sharedClient);
    const second = await render(sharedClient);

    const input = first.querySelector<HTMLInputElement>('input[name="new-task"]');
    if (!input) throw new Error("Missing new-task input");
    await type(input, "Visible in both sessions");
    await click(button(first, "Add task"));
    expect(first.textContent).toContain("Visible in both sessions");
    expect(second.textContent).toContain("Visible in both sessions");

    await click(button(second, "Complete Visible in both sessions"));
    expect(first.textContent).not.toContain("Visible in both sessions");
    expect(second.textContent).not.toContain("Visible in both sessions");

    for (let index = 0; index < 24; index += 1) {
      await sharedClient.createTask(`Bounded receipt ${index + 1}`);
    }
    expect(first.querySelectorAll(".receipt-list li")).toHaveLength(20);
    expect(second.querySelectorAll(".receipt-list li")).toHaveLength(20);
    expect(first.textContent).not.toContain("demo_capability");
    expect(second.textContent).not.toContain("demo_capability");
  });
});
