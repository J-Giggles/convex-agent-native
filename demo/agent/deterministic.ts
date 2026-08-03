import type { Task } from "../actions/task-actions.js";

type InvokePlan = {
  kind: "invoke";
  actionName: "list-tasks" | "create-task" | "update-task";
  input: Record<string, unknown>;
};
type ConfirmPlan = {
  kind: "confirm";
  actionName: "delete-task";
  input: { taskId: string };
  taskTitle: string;
};
type ReplyPlan = {
  kind: "reply";
  code: "ambiguous-task" | "missing-task" | "unsupported" | "invalid-prompt";
  text: string;
};
export type DeterministicPlan = InvokePlan | ConfirmPlan | ReplyPlan;

function cleanTitle(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function findTask(title: string, tasks: readonly Task[]): Task | ReplyPlan {
  const wanted = cleanTitle(title).toLocaleLowerCase();
  const matches = tasks.filter(({ title: candidate }) => candidate.trim().toLocaleLowerCase() === wanted);
  if (matches.length > 1) {
    return {
      kind: "reply",
      code: "ambiguous-task",
      text: `More than one task is named “${cleanTitle(title)}”. Rename one in the list first.`,
    };
  }
  if (matches.length === 0) {
    return {
      kind: "reply",
      code: "missing-task",
      text: `I couldn't find a task named “${cleanTitle(title)}”.`,
    };
  }
  return matches[0]!;
}

export function interpretDemoPrompt(prompt: string, tasks: readonly Task[]): DeterministicPlan {
  const bounded = prompt.trim();
  if (!bounded || bounded.length > 500) {
    return {
      kind: "reply",
      code: "invalid-prompt",
      text: "Please use a prompt between 1 and 500 characters.",
    };
  }

  if (/^(?:list|show)(?:\s+all)?(?:\s+tasks)?$/iu.test(bounded)) {
    return {
      kind: "invoke",
      actionName: "list-tasks",
      input: { includeDone: /\ball\b/iu.test(bounded) },
    };
  }

  const create = /^(?:add|create)(?:\s+(?:a\s+)?task)?\s+(.+)$/iu.exec(bounded);
  if (create) {
    const title = cleanTitle(create[1]!);
    if (title) return { kind: "invoke", actionName: "create-task", input: { title } };
  }

  const rename = /^rename\s+(.+?)\s+to\s+(.+)$/iu.exec(bounded);
  if (rename) {
    const task = findTask(rename[1]!, tasks);
    if ("kind" in task) return task;
    const title = cleanTitle(rename[2]!);
    if (!title) return { kind: "reply", code: "invalid-prompt", text: "The new title is empty." };
    return { kind: "invoke", actionName: "update-task", input: { taskId: task.id, title } };
  }

  const completion = /^(complete|reopen)\s+(.+)$/iu.exec(bounded);
  if (completion) {
    const task = findTask(completion[2]!, tasks);
    if ("kind" in task) return task;
    return {
      kind: "invoke",
      actionName: "update-task",
      input: { taskId: task.id, done: completion[1]!.toLowerCase() === "complete" },
    };
  }

  const deletion = /^delete\s+(.+)$/iu.exec(bounded);
  if (deletion) {
    const task = findTask(deletion[1]!, tasks);
    if ("kind" in task) return task;
    return {
      kind: "confirm",
      actionName: "delete-task",
      input: { taskId: task.id },
      taskTitle: task.title,
    };
  }

  return {
    kind: "reply",
    code: "unsupported",
    text: "I can list, add, rename, complete, reopen, or delete tasks in this demo.",
  };
}
