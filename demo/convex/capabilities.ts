import {
  resolveActionScope,
  type ResolvedActionScope,
} from "@giggabit/agent-native-convex/contracts";

const TOKEN_PREFIX = "demo_";
const PUBLIC_ID_BYTES = 12;
const SECRET_BYTES = 20;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{27}$/u;

export interface DemoCapability {
  publicId: string;
  secret: string;
  token: string;
}

function base64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function createCapability(entropy: Uint8Array): DemoCapability {
  if (entropy.byteLength !== PUBLIC_ID_BYTES + SECRET_BYTES) {
    throw new Error("Demo capabilities require exactly 32 bytes of entropy");
  }
  const publicId = base64Url(entropy.slice(0, PUBLIC_ID_BYTES));
  const secret = base64Url(entropy.slice(PUBLIC_ID_BYTES));
  return { publicId, secret, token: `${TOKEN_PREFIX}${publicId}.${secret}` };
}

export function parseCapability(token: string): Pick<DemoCapability, "publicId" | "secret"> {
  const separator = token.indexOf(".");
  const publicId = token.startsWith(TOKEN_PREFIX)
    ? token.slice(TOKEN_PREFIX.length, separator)
    : "";
  const secret = separator >= 0 ? token.slice(separator + 1) : "";
  if (
    separator <= TOKEN_PREFIX.length ||
    token.indexOf(".", separator + 1) !== -1 ||
    !PUBLIC_ID_PATTERN.test(publicId) ||
    !SECRET_PATTERN.test(secret)
  ) {
    throw new Error("Invalid demo capability");
  }
  return { publicId, secret };
}

export async function capabilityDigest(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function demoSessionScopeKey(publicId: string, resetVersion = 0): string {
  if (
    !PUBLIC_ID_PATTERN.test(publicId) ||
    !Number.isSafeInteger(resetVersion) ||
    resetVersion < 0
  ) {
    throw new Error("Invalid stored demo capability");
  }
  return `demo:${publicId}${resetVersion === 0 ? "" : `:r${resetVersion}`}`;
}

export function demoSessionQuotaKey(publicId: string): string {
  return `${demoSessionScopeKey(publicId)}:quota`;
}

export function resolveCapabilityScope(input: {
  publicId: string;
  secretDigest: string;
  scopeKey?: string;
}): ResolvedActionScope {
  if (!PUBLIC_ID_PATTERN.test(input.publicId) || !/^[a-f0-9]{64}$/u.test(input.secretDigest)) {
    throw new Error("Invalid stored demo capability");
  }
  const baseScopeKey = demoSessionScopeKey(input.publicId);
  const scopeKey = input.scopeKey ?? baseScopeKey;
  if (
    scopeKey !== baseScopeKey &&
    !new RegExp(`^${baseScopeKey}:r[1-9][0-9]*$`, "u").test(scopeKey)
  ) {
    throw new Error("Invalid stored demo capability");
  }
  return resolveActionScope({
    scopeKey,
    subjectId: `anonymous:${input.publicId}`,
    organizationId: scopeKey,
  });
}
