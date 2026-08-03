import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { DemoClient, Task } from "./demoClient.js";

export interface AppProps {
  client: DemoClient;
}

type Confirmation = { kind: "delete"; task: Task } | { kind: "reset" } | null;
type OptimisticTasks = { baseline: Task[]; tasks: Task[] } | null;

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const safe = /^(?:Demo (?:quota exceeded|session unavailable)|Task not found)$/u.test(message)
    ? message
    : "That request could not be completed. Please try again.";
  return safe.slice(0, 160);
}

function ConfirmationDialog({
  confirmation,
  pending,
  onCancel,
  onConfirm,
}: {
  confirmation: Exclude<Confirmation, null>;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">
        {confirmation.kind === "delete" ? "Delete this task?" : "Reset this demo?"}
      </h2>
      <p>
        {confirmation.kind === "delete"
          ? `“${confirmation.task.title}” will be permanently removed.`
          : "Your tasks will be replaced with the original seeded examples."}
      </p>
      <div className="dialog-actions">
        <button autoFocus type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="danger-button" disabled={pending} onClick={onConfirm}>
          {confirmation.kind === "delete" ? "Delete permanently" : "Reset tasks"}
        </button>
      </div>
    </dialog>
  );
}

export function App({ client }: AppProps) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [newTitle, setNewTitle] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [optimistic, setOptimistic] = useState<OptimisticTasks>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentTasks = optimistic?.tasks ?? snapshot.tasks;
  const visibleTasks = snapshot.includeDone
    ? currentTasks
    : currentTasks.filter(({ done }) => !done);

  useEffect(() => {
    if (optimistic && snapshot.tasks !== optimistic.baseline) setOptimistic(null);
  }, [optimistic, snapshot.tasks]);

  async function run(
    operation: () => Promise<void>,
    after?: () => void,
    optimisticTasks?: Task[],
  ) {
    setPending(true);
    setError(null);
    if (optimisticTasks) setOptimistic({ baseline: snapshot.tasks, tasks: optimisticTasks });
    try {
      await operation();
      after?.();
    } catch (caught) {
      setOptimistic(null);
      setError(boundedError(caught));
    } finally {
      setPending(false);
    }
  }

  function submitNewTask(event: FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) {
      setError("Task title is required.");
      return;
    }
    void run(
      () => client.createTask(title),
      () => setNewTitle(""),
      [...currentTasks, { id: "optimistic:new-task", title, done: false }],
    );
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    const title = editTitle.trim();
    if (!editing || !title) {
      setError("Task title is required.");
      return;
    }
    void run(
      () => client.updateTask(editing.id, { title }),
      () => setEditing(null),
      currentTasks.map((task) => (task.id === editing.id ? { ...task, title } : task)),
    );
  }

  function submitAgentPrompt(event: FormEvent) {
    event.preventDefault();
    const prompt = agentPrompt.trim();
    if (!prompt) {
      setError("Ask the agent to list, add, rename, complete, reopen, or delete a task.");
      return;
    }
    void run(() => client.sendChat(prompt), () => setAgentPrompt(""));
  }

  function beginEdit(task: Task) {
    setEditing(task);
    setEditTitle(task.title);
    setError(null);
  }

  function confirm() {
    if (confirmation?.kind === "delete") {
      const taskId = confirmation.task.id;
      setConfirmation(null);
      void run(
        () => client.deleteTask(taskId),
        undefined,
        currentTasks.filter((task) => task.id !== taskId),
      );
    } else if (confirmation?.kind === "reset") {
      setConfirmation(null);
      void run(
        () => client.reset(),
        undefined,
        [
          { id: "optimistic:seed-1", title: "Record the demo", done: false },
          { id: "optimistic:seed-2", title: "Get groceries", done: false },
        ],
      );
    }
  }

  return (
    <div className="site-shell">
      <header className="hero">
        <p className="eyebrow">Convex × Agent Native</p>
        <h1>Your tasks, one shared action surface.</h1>
        <p>
          A reactive to-do workspace where the UI, agent, and MCP clients operate on the same
          durable Convex state.
        </p>
      </header>

      <main className="workspace">
        <section className="task-card" aria-labelledby="tasks-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Live workspace</p>
              <h2 id="tasks-heading">Tasks</h2>
            </div>
            <button className="quiet-button" type="button" disabled={pending} onClick={() => setConfirmation({ kind: "reset" })}>
              Reset demo
            </button>
          </div>

          <form className="add-task" onSubmit={submitNewTask}>
            <label className="sr-only" htmlFor="new-task">New task</label>
            <input
              id="new-task"
              name="new-task"
              maxLength={160}
              placeholder="What needs doing?"
              value={newTitle}
              onChange={(event) => setNewTitle(event.currentTarget.value)}
            />
            <button type="submit" disabled={pending}>Add task</button>
          </form>

          {(error ?? snapshot.error) && (
            <p className="error" role="alert" aria-live="polite">
              {error ?? boundedError(new Error(snapshot.error))}
            </p>
          )}
          {snapshot.loading ? (
            <p className="empty-state" role="status">Connecting to your demo…</p>
          ) : visibleTasks.length === 0 ? (
            <p className="empty-state">Nothing left here. Add a task or show completed work.</p>
          ) : (
            <ul className="task-list">
              {visibleTasks.map((task) => (
                <li className={task.done ? "task-row task-row--done" : "task-row"} key={task.id}>
                  {editing?.id === task.id ? (
                    <form className="edit-task" onSubmit={submitEdit}>
                      <label className="sr-only" htmlFor={`edit-${task.id}`}>Edit {task.title}</label>
                      <input
                        autoFocus
                        id={`edit-${task.id}`}
                        name="edit-task"
                        maxLength={160}
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.currentTarget.value)}
                      />
                      <button type="submit" disabled={pending}>Save edit</button>
                      <button type="button" className="quiet-button" onClick={() => setEditing(null)}>Cancel edit</button>
                    </form>
                  ) : (
                    <>
                      <button
                        className="check-button"
                        type="button"
                        aria-label={`${task.done ? "Reopen" : "Complete"} ${task.title}`}
                        aria-pressed={task.done}
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () => client.updateTask(task.id, { done: !task.done }),
                            undefined,
                            currentTasks.map((candidate) =>
                              candidate.id === task.id ? { ...candidate, done: !task.done } : candidate,
                            ),
                          )
                        }
                      >
                        <span aria-hidden="true">{task.done ? "✓" : ""}</span>
                      </button>
                      <span className="task-title">{task.title}</span>
                      <div className="task-actions">
                        <button className="quiet-button" type="button" aria-label={`Edit ${task.title}`} disabled={pending} onClick={() => beginEdit(task)}>Edit</button>
                        <button className="danger-button" type="button" aria-label={`Delete ${task.title}`} disabled={pending} onClick={() => setConfirmation({ kind: "delete", task })}>Delete</button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <label className="show-completed">
            <input
              type="checkbox"
              name="show-completed"
              checked={snapshot.includeDone}
              onChange={(event) => client.setIncludeDone(event.currentTarget.checked)}
            />
            Show completed
          </label>
        </section>

        <section className="agent-card" aria-labelledby="agent-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Built-in agent</p>
              <h2 id="agent-heading">Ask your task agent</h2>
            </div>
            <span className="mode-badge">Deterministic demo mode</span>
          </div>
          <p className="agent-explainer">
            This zero-cost public agent uses the exact same Builder-style action definitions as
            the UI and MCP endpoint. A server-only provider plug-in seam is documented for private deployments.
          </p>
          <div className="chat-log" role="log" aria-live="polite" aria-label="Agent conversation">
            {snapshot.messages.length === 0 ? (
              <p className="empty-state">Try “list tasks” or “add Buy oat milk”.</p>
            ) : (
              snapshot.messages.map((message) => (
                <p className={`chat-message chat-message--${message.role}`} key={message.id}>
                  <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                  <span>{message.content}</span>
                </p>
              ))
            )}
          </div>
          <form className="agent-form" onSubmit={submitAgentPrompt}>
            <label className="sr-only" htmlFor="agent-prompt">Message the built-in agent</label>
            <textarea
              id="agent-prompt"
              name="agent-prompt"
              maxLength={500}
              rows={3}
              placeholder="Ask the agent to work with your tasks…"
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.currentTarget.value)}
            />
            <button type="submit" disabled={pending}>Send to agent</button>
          </form>
        </section>

        <aside className="receipt-card" aria-labelledby="receipts-heading">
          <p className="eyebrow">Durable evidence</p>
          <h2 id="receipts-heading">Audit receipts</h2>
          <p>Every action surface leaves the same bounded, secret-free receipt.</p>
          {snapshot.receipts.length === 0 ? (
            <p className="empty-state">Receipts will appear after your first change.</p>
          ) : (
            <ol className="receipt-list">
              {snapshot.receipts.slice(0, 20).map((receipt) => (
                <li key={receipt.invocationId}>
                  <span className={`status status--${receipt.status}`}>{receipt.status}</span>
                  <strong>{receipt.actionName}</strong>
                  <span>{receipt.caller}{receipt.replayed ? " · replayed" : ""}</span>
                  <code>{receipt.invocationId}</code>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>

      <footer>
        <strong>Independent Convex port.</strong>{" "}
        Inspired by the agent-first application demonstrated by{" "}
        <a href="https://www.builder.io/" rel="noreferrer">Builder.io</a>. Review the{" "}
        <a href="https://www.builder.io/blog/agent-first-apps" rel="noreferrer">original walkthrough</a>{" "}
        and <a href="https://github.com/BuilderIO/agent-native" rel="noreferrer">MIT-licensed reference repository</a>.
        Not affiliated with or endorsed by Builder.io.
      </footer>

      {confirmation && (
        <ConfirmationDialog
          confirmation={confirmation}
          pending={pending}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirm}
        />
      )}
    </div>
  );
}
