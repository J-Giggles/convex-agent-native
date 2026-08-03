import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";

import type { AuditReceipt, ChatMessage, DemoClient, DemoSnapshot, Task } from "./demoClient.js";

const STORAGE_KEY = "convex-agent-native.demo-capability.v1";
const CAPABILITY_PATTERN = /^demo_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{27}$/u;
const PUBLIC_ERROR = "The public demo could not start. Please try again later.";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConvexTransport {
  watchQuery(
    name: string,
    args: Record<string, unknown>,
    update: (value: unknown) => void,
    error: (error: unknown) => void,
  ): () => void;
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface ConnectDemoClientOptions {
  convexUrl: string;
  siteUrl: string;
  storage?: StorageLike;
  fetcher?: typeof fetch;
  transport?: ConvexTransport;
  idempotencyKey?: () => string;
}

const browserCapabilityStorage: StorageLike = {
  getItem(key) {
    if (key !== STORAGE_KEY) return null;
    return sessionStorage.getItem("convex-agent-native.demo-capability.v1");
  },
  setItem(key, value) {
    if (key !== STORAGE_KEY) throw new Error("Unsupported demo storage key");
    sessionStorage.setItem("convex-agent-native.demo-capability.v1", value);
  },
  removeItem(key) {
    if (key !== STORAGE_KEY) return;
    sessionStorage.removeItem("convex-agent-native.demo-capability.v1");
  },
};

class BrowserConvexTransport implements ConvexTransport {
  private readonly client: ConvexReactClient;

  constructor(url: string) {
    this.client = new ConvexReactClient(url, { unsavedChangesWarning: false });
  }

  watchQuery(
    name: string,
    args: Record<string, unknown>,
    update: (value: unknown) => void,
    error: (error: unknown) => void,
  ) {
    const reference = makeFunctionReference<"query">(name);
    const watch = this.client.watchQuery(reference, args);
    return watch.onUpdate(() => {
      try {
        const result = watch.localQueryResult();
        if (result !== undefined) update(result);
      } catch (caught) {
        error(caught);
      }
    });
  }

  action(name: string, args: Record<string, unknown>) {
    return this.client.action(makeFunctionReference<"action">(name), args);
  }

  mutation(name: string, args: Record<string, unknown>) {
    return this.client.mutation(makeFunctionReference<"mutation">(name), args);
  }

  close() {
    void this.client.close();
  }
}

function assertPublicUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not configured.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
    task.id.length <= 128 &&
    typeof task.title === "string" &&
    task.title.trim().length > 0 &&
    task.title.length <= 160 &&
    typeof task.done === "boolean"
  );
}

function isReceipt(value: unknown): value is AuditReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.invocationId === "string" &&
    receipt.invocationId.length > 0 &&
    receipt.invocationId.length <= 128 &&
    typeof receipt.actionName === "string" &&
    receipt.actionName.length > 0 &&
    receipt.actionName.length <= 80 &&
    typeof receipt.caller === "string" &&
    receipt.caller.length > 0 &&
    receipt.caller.length <= 32 &&
    (receipt.status === "running" || receipt.status === "completed" || receipt.status === "failed") &&
    typeof receipt.createdAt === "number" &&
    typeof receipt.updatedAt === "number" &&
    (receipt.replayed === undefined || typeof receipt.replayed === "boolean")
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    message.id.length > 0 &&
    message.id.length <= 128 &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.length <= 2_000 &&
    typeof message.createdAt === "number"
  );
}

async function capabilityForSession(
  siteUrl: string,
  storage: StorageLike,
  fetcher: typeof fetch,
): Promise<string> {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored && CAPABILITY_PATTERN.test(stored)) return stored;
  if (stored) storage.removeItem(STORAGE_KEY);

  try {
    const response = await fetcher(`${siteUrl}/demo/session`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("bootstrap refused");
    const payload = (await response.json()) as { capability?: unknown };
    if (typeof payload.capability !== "string" || !CAPABILITY_PATTERN.test(payload.capability)) {
      throw new Error("invalid bootstrap response");
    }
    storage.setItem(STORAGE_KEY, payload.capability);
    return payload.capability;
  } catch {
    storage.removeItem(STORAGE_KEY);
    throw new Error(PUBLIC_ERROR);
  }
}

class ConvexDemoClient implements DemoClient {
  private listeners = new Set<() => void>();
  private taskUnsubscribe: (() => void) | null = null;
  private receiptUnsubscribe: (() => void) | null = null;
  private chatUnsubscribe: (() => void) | null = null;
  private snapshot: DemoSnapshot = {
    loading: true,
    includeDone: false,
    tasks: [],
    receipts: [],
    messages: [],
  };

  constructor(
    private readonly capability: string,
    private readonly transport: ConvexTransport,
    private readonly nextIdempotencyKey: () => string,
  ) {
    this.subscribeToTasks();
    this.receiptUnsubscribe = transport.watchQuery(
      "receipts:list",
      { capability },
      (value) => {
        if (!Array.isArray(value) || value.length > 100 || !value.every(isReceipt)) {
          this.failSubscription();
          return;
        }
        this.patch({ receipts: value.slice(0, 20) });
      },
      () => this.failSubscription(),
    );
    this.chatUnsubscribe = transport.watchQuery(
      "chat:list",
      { capability },
      (value) => {
        if (!Array.isArray(value) || value.length > 40 || !value.every(isChatMessage)) {
          this.failSubscription();
          return;
        }
        this.patch({ messages: value });
      },
      () => this.failSubscription(),
    );
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  setIncludeDone(includeDone: boolean) {
    if (includeDone === this.snapshot.includeDone) return;
    this.patch({ includeDone, loading: true });
    this.subscribeToTasks();
  }

  async createTask(title: string) {
    await this.invoke("create-task", { title });
  }

  async updateTask(taskId: string, patch: Pick<Partial<Task>, "title" | "done">) {
    await this.invoke("update-task", { taskId, ...patch });
  }

  async deleteTask(taskId: string) {
    await this.invoke("delete-task", { taskId });
  }

  async sendChat(prompt: string) {
    await this.transport.action("chatAction:send", { capability: this.capability, prompt });
  }

  async reset() {
    await this.transport.mutation("sessions:reset", { capability: this.capability });
  }

  close() {
    this.taskUnsubscribe?.();
    this.receiptUnsubscribe?.();
    this.chatUnsubscribe?.();
    this.transport.close();
  }

  private async invoke(actionName: string, input: Record<string, unknown>) {
    await this.transport.action("actions:invoke", {
      capability: this.capability,
      actionName,
      input,
      idempotencyKey: this.nextIdempotencyKey(),
    });
  }

  private subscribeToTasks() {
    this.taskUnsubscribe?.();
    this.taskUnsubscribe = this.transport.watchQuery(
      "tasks:list",
      { capability: this.capability, includeDone: this.snapshot.includeDone },
      (value) => {
        if (!Array.isArray(value) || value.length > 200 || !value.every(isTask)) {
          this.failSubscription();
          return;
        }
        this.patch({ tasks: value, loading: false, error: undefined });
      },
      () => this.failSubscription(),
    );
  }

  private failSubscription() {
    this.patch({ loading: false, error: "Demo session unavailable" });
  }

  private patch(patch: Partial<DemoSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export async function connectConvexDemoClient(
  options: ConnectDemoClientOptions,
): Promise<DemoClient & { close(): void }> {
  const convexUrl = assertPublicUrl(options.convexUrl, "VITE_CONVEX_URL");
  const siteUrl = assertPublicUrl(options.siteUrl, "VITE_CONVEX_SITE_URL");
  const capability = await capabilityForSession(
    siteUrl,
    options.storage ?? browserCapabilityStorage,
    options.fetcher ?? fetch,
  );
  const transport = options.transport ?? new BrowserConvexTransport(convexUrl);
  return new ConvexDemoClient(
    capability,
    transport,
    options.idempotencyKey ?? (() => crypto.randomUUID()),
  );
}
