import { describe, expect, it } from "vitest";

import { interpretDemoPrompt } from "./deterministic.js";

const tasks = [
  { id: "task-1", title: "Record the demo", done: false, sortOrder: 0, createdAt: 1, updatedAt: 1 },
  { id: "task-2", title: "Get groceries", done: false, sortOrder: 1, createdAt: 1, updatedAt: 1 },
];

describe("deterministic safe demo agent", () => {
  it("CHT-N-001 maps supported user intents onto the shared task action names", () => {
    expect(interpretDemoPrompt("add Make my demo", tasks)).toEqual({
      kind: "invoke",
      actionName: "create-task",
      input: { title: "Make my demo" },
    });
    expect(interpretDemoPrompt("complete get groceries", tasks)).toEqual({
      kind: "invoke",
      actionName: "update-task",
      input: { taskId: "task-2", done: true },
    });
    expect(interpretDemoPrompt("show all tasks", tasks)).toEqual({
      kind: "invoke",
      actionName: "list-tasks",
      input: { includeDone: true },
    });
  });

  it("CHT-F-001 refuses ambiguous, unsupported, and unconfirmed destructive prompts", () => {
    const duplicate = [...tasks, { ...tasks[1]!, id: "task-3" }];
    expect(interpretDemoPrompt("complete get groceries", duplicate)).toMatchObject({
      kind: "reply",
      code: "ambiguous-task",
    });
    expect(interpretDemoPrompt("email my manager", tasks)).toMatchObject({
      kind: "reply",
      code: "unsupported",
    });
    expect(interpretDemoPrompt("delete get groceries", tasks)).toEqual({
      kind: "confirm",
      actionName: "delete-task",
      input: { taskId: "task-2" },
      taskTitle: "Get groceries",
    });
  });

  it("CHT-I-001 emits only bounded public action input without credentials or provider state", () => {
    const plan = interpretDemoPrompt("rename record the demo to Record launch", tasks);
    expect(plan).toEqual({
      kind: "invoke",
      actionName: "update-task",
      input: { taskId: "task-1", title: "Record launch" },
    });
    expect(JSON.stringify(plan)).not.toMatch(/capability|token|provider|prompt/iu);
  });
});
