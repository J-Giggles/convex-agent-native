import type { ExecuteRegisteredActionResult } from "@giggabit/agent-native-convex/action";

import type { Task } from "../actions/task-actions.js";
import { interpretDemoPrompt, type DeterministicPlan } from "./deterministic.js";

export interface DemoChatDependencies {
  listTasks(): Promise<Task[]>;
  invoke(
    actionName: "list-tasks" | "create-task" | "update-task" | "delete-task",
    input: Record<string, unknown>,
    options: { approved: boolean; idempotencyKey: string },
  ): Promise<ExecuteRegisteredActionResult>;
  append(role: "user" | "assistant", content: string): Promise<void>;
  claimPendingDelete(): Promise<{ taskId: string; taskTitle: string } | null>;
  setPendingDelete(value: { taskId: string; taskTitle: string }): Promise<void>;
  nextIdempotencyKey(): string;
}

export type ChatResult =
  | {
      status: "completed";
      actionName: string;
      invocationId?: string;
      replayed: boolean;
      message: string;
    }
  | {
      status: "confirmation-required";
      actionName: "delete-task";
      message: string;
    }
  | { status: "refused"; code: string; message: string };

function resultMessage(actionName: string, result: unknown): string {
  if (actionName === "list-tasks") {
    const tasks =
      result && typeof result === "object" && "tasks" in result && Array.isArray(result.tasks)
        ? (result.tasks as Array<{ title?: unknown; done?: unknown }>).slice(0, 20)
        : [];
    if (tasks.length === 0) return "There are no matching tasks.";
    return tasks
      .map((task) => `${task.done === true ? "✓" : "○"} ${String(task.title ?? "Untitled").slice(0, 160)}`)
      .join("\n")
      .slice(0, 2_000);
  }
  if (actionName === "create-task") return "Task added.";
  if (actionName === "update-task") return "Task updated.";
  return "Task deleted.";
}

export async function handleDemoChat(
  prompt: string,
  dependencies: DemoChatDependencies,
  planPrompt: (
    prompt: string,
    tasks: readonly Task[],
  ) => DeterministicPlan | Promise<DeterministicPlan> = interpretDemoPrompt,
): Promise<ChatResult> {
  const boundedPrompt = prompt.trim().slice(0, 500);
  await dependencies.append("user", boundedPrompt);

  if (/^confirm(?:\s+delete)?$/iu.test(boundedPrompt)) {
    const pending = await dependencies.claimPendingDelete();
    if (!pending) {
      const message = "There is no pending task deletion to confirm.";
      await dependencies.append("assistant", message);
      return { status: "refused", code: "confirmation-missing", message };
    }
    const receipt = await dependencies.invoke(
      "delete-task",
      { taskId: pending.taskId },
      { approved: true, idempotencyKey: dependencies.nextIdempotencyKey() },
    );
    const message = `Deleted “${pending.taskTitle.slice(0, 160)}”.`;
    await dependencies.append("assistant", message);
    return {
      status: "completed",
      actionName: "delete-task",
      ...(receipt.invocationId === undefined ? {} : { invocationId: receipt.invocationId }),
      replayed: receipt.replayed,
      message,
    };
  }

  const plan = await planPrompt(boundedPrompt, await dependencies.listTasks());
  if (plan.kind === "reply") {
    await dependencies.append("assistant", plan.text);
    return { status: "refused", code: plan.code, message: plan.text };
  }
  if (plan.kind === "confirm") {
    await dependencies.setPendingDelete({
      taskId: plan.input.taskId,
      taskTitle: plan.taskTitle,
    });
    const message = `Delete “${plan.taskTitle.slice(0, 160)}”? Reply “confirm delete” to continue.`;
    await dependencies.append("assistant", message);
    return { status: "confirmation-required", actionName: "delete-task", message };
  }

  const receipt = await dependencies.invoke(plan.actionName, plan.input, {
    approved: false,
    idempotencyKey: dependencies.nextIdempotencyKey(),
  });
  const message = resultMessage(plan.actionName, receipt.result);
  await dependencies.append("assistant", message);
  return {
    status: "completed",
    actionName: plan.actionName,
    ...(receipt.invocationId === undefined ? {} : { invocationId: receipt.invocationId }),
    replayed: receipt.replayed,
    message,
  };
}
