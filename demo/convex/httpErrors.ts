export interface PublicHttpFailure {
  status: 400 | 401 | 429 | 500;
  code: "invalid_request" | "unauthorized" | "capacity" | "internal";
}

export function publicHttpFailure(error: unknown): PublicHttpFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Demo session unavailable")) {
    return { status: 401, code: "unauthorized" };
  }
  if (message.includes("Demo quota exceeded")) {
    return { status: 429, code: "capacity" };
  }
  if (
    /(?:request refused|Unknown action|Invalid action|did not match|Task (?:not found|limit reached)|Operation conflict|approval)/iu.test(
      message,
    )
  ) {
    return { status: 400, code: "invalid_request" };
  }
  return { status: 500, code: "internal" };
}
