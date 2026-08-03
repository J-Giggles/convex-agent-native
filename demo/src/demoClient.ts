export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export interface AuditReceipt {
  invocationId: string;
  actionName: string;
  caller: string;
  status: "running" | "completed" | "failed";
  replayed?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface DemoSnapshot {
  loading: boolean;
  includeDone: boolean;
  tasks: Task[];
  receipts: AuditReceipt[];
  messages: ChatMessage[];
  error?: string | undefined;
}

export interface DemoClient {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DemoSnapshot;
  setIncludeDone(includeDone: boolean): void;
  createTask(title: string): Promise<void>;
  updateTask(taskId: string, patch: Pick<Partial<Task>, "title" | "done">): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  sendChat(prompt: string): Promise<void>;
  reset(): Promise<void>;
}
