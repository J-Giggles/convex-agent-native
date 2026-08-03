const ALLOWED_ORIGINS = new Set([
  "https://j-giggles.github.io",
  "http://localhost:4173",
  "http://localhost:5173",
]);

function normalizedIp(value: string | null): string | null {
  if (!value) return null;
  const candidate = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!candidate || candidate.length > 64 || !/^[0-9a-f:.]+$/iu.test(candidate)) return null;
  return candidate.toLowerCase();
}

export function allowedBootstrapOrigin(request: Request): string {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) throw new Error("Demo bootstrap unavailable");
  return origin;
}

export function resolveBootstrapRequest(request: Request) {
  const allowOrigin = allowedBootstrapOrigin(request);
  const forwarded = normalizedIp(request.headers.get("x-forwarded-for"));
  const real = normalizedIp(request.headers.get("x-real-ip"));
  const cloudflare = normalizedIp(request.headers.get("cf-connecting-ip"));
  const address = forwarded ?? real ?? cloudflare;
  if (!address) throw new Error("Demo bootstrap unavailable");
  return { allowOrigin, provenance: `forwarded:${address}` };
}

export function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "Origin",
  } as const;
}
