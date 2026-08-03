import {
  ActionRegistry,
  defineConvexAction as defineAction,
  readActionExecutionContext,
} from "@giggabit/agent-native-convex/action";
import type { ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskStore {
  readonly scopeKey: string;
  list(includeDone: boolean): Promise<Task[]>;
  create(title: string): Promise<Task>;
  update(taskId: string, patch: { title?: string; done?: boolean }): Promise<Task>;
  delete(taskId: string): Promise<void>;
}

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const sharedSafety = {
  audit: { enabled: false as const },
  outputErrorStrategy: "strict" as const,
};

function taskStore(context: ActionRunContext | undefined): TaskStore {
  const execution = readActionExecutionContext<{ taskStore?: unknown }>(context);
  const store = execution.taskStore;
  if (!store || typeof store !== "object" || typeof (store as TaskStore).scopeKey !== "string") {
    throw new Error("Task action store unavailable");
  }
  return store as TaskStore;
}

const listTasks = defineAction({
  description: "List tasks for the current demo session. By default returns incomplete tasks only.",
  schema: z.object({ includeDone: z.boolean().default(false) }),
  toolParameters: {
    type: "object",
    properties: { includeDone: { type: "boolean", description: "Include completed tasks" } },
  },
  outputSchema: z.object({
    tasks: z.array(taskSchema),
    hasCompletedTasks: z.boolean().optional(),
  }),
  ...sharedSafety,
  http: { method: "GET" },
  readOnly: true,
  publicAgent: { expose: true, readOnly: true, requiresAuth: true },
  run: async ({ includeDone }, context) => {
    const store = taskStore(context);
    const tasks = await store.list(includeDone);
    const hasCompletedTasks = includeDone
      ? undefined
      : tasks.length === 0
        ? (await store.list(true)).some(({ done }) => done)
        : false;
    return {
      tasks,
      ...(hasCompletedTasks === undefined ? {} : { hasCompletedTasks }),
    };
  },
});

const createTask = defineAction({
  description: "Create an incomplete task directly on the task list.",
  schema: z.object({ title: z.string().trim().min(1).max(160).describe("Task title") }),
  toolParameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title", minLength: 1, maxLength: 160 },
    },
    required: ["title"],
  },
  outputSchema: taskSchema,
  ...sharedSafety,
  publicAgent: { expose: true, readOnly: false, requiresAuth: true },
  run: ({ title }, context) => taskStore(context).create(title),
});

const updateTask = defineAction({
  description: "Update one task's title and/or completion state.",
  schema: z.object({
    taskId: z.string().describe("Task id"),
    title: z.string().trim().min(1).max(160).optional().describe("New task title"),
    done: z.boolean().optional().describe("Completion state"),
  }),
  toolParameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task id" },
      title: { type: "string", description: "New task title", minLength: 1, maxLength: 160 },
      done: { type: "boolean", description: "Completion state" },
    },
    required: ["taskId"],
  },
  outputSchema: taskSchema,
  ...sharedSafety,
  publicAgent: { expose: true, readOnly: false, requiresAuth: true },
  run: ({ taskId, title, done }, context) => {
    if (title === undefined && done === undefined) {
      throw new Error("Provide at least one of title or done.");
    }
    return taskStore(context).update(taskId, {
      ...(title === undefined ? {} : { title }),
      ...(done === undefined ? {} : { done }),
    });
  },
});

const deleteTask = defineAction({
  description: "Delete one task permanently. Ask the user to confirm before calling.",
  schema: z.object({ taskId: z.string().describe("Task id") }),
  toolParameters: {
    type: "object",
    properties: { taskId: { type: "string", description: "Task id" } },
    required: ["taskId"],
  },
  outputSchema: z.object({ ok: z.literal(true) }),
  ...sharedSafety,
  publicAgent: { expose: true, readOnly: false, requiresAuth: true },
  needsApproval: (_input, context) => context?.caller === "tool" || context?.caller === "mcp",
  run: async ({ taskId }, context) => {
    await taskStore(context).delete(taskId);
    return { ok: true as const };
  },
});

export const taskActionDefinitions = Object.freeze({
  "list-tasks": listTasks,
  "create-task": createTask,
  "update-task": updateTask,
  "delete-task": deleteTask,
} as const);

export function createTaskActionCatalog(store: TaskStore) {
  const definitions = taskActionDefinitions;
  const authorize = (_input: unknown, context: { orgId?: string | null }) =>
    store.scopeKey === context.orgId;
  const registry = new ActionRegistry()
    .register("list-tasks", listTasks)
    .register("create-task", createTask, {
      authorizeBeforeClaim: authorize,
      projectReplayResult: (result: Task) => ({ taskId: result.id, done: result.done }),
    })
    .register("update-task", updateTask, {
      authorizeBeforeClaim: authorize,
      projectReplayResult: (result: Task) => ({ taskId: result.id, done: result.done }),
    })
    .register("delete-task", deleteTask, {
      authorizeBeforeClaim: authorize,
      projectReplayResult: (result: { ok: true }) => result,
    });
  return { definitions, registry };
}
