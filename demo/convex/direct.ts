import { parseCapability } from "./capabilities.js";

const MAX_DIRECT_BODY_BYTES = 66 * 1024;
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;

export interface DirectActionEnvelope {
  capability: string;
  actionName: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

function refused(): never {
  throw new Error("Direct action request refused");
}

export async function readDirectActionEnvelope(request: Request): Promise<DirectActionEnvelope> {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) refused();
  const capability = match[1]!;
  try {
    parseCapability(capability);
  } catch {
    refused();
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_DIRECT_BODY_BYTES) refused();
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_DIRECT_BODY_BYTES) refused();

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    refused();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) refused();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "actionName" && key !== "input")) refused();
  if (typeof record.actionName !== "string" || !ACTION_NAME_PATTERN.test(record.actionName)) refused();
  if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) refused();

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (idempotencyKey && !IDEMPOTENCY_PATTERN.test(idempotencyKey)) refused();
  if (record.actionName !== "list-tasks" && !idempotencyKey) refused();

  return {
    capability,
    actionName: record.actionName,
    input: record.input as Record<string, unknown>,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
