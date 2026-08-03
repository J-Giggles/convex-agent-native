const ALLOWED_ORIGINS = new Set([
  "https://j-giggles.github.io",
  "http://localhost:4173",
  "http://localhost:5173",
]);

export function allowedBootstrapOrigin(request: Request): string {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) throw new Error("Demo bootstrap unavailable");
  return origin;
}

export function resolveBootstrapRequest(request: Request) {
  const allowOrigin = allowedBootstrapOrigin(request);
  return { allowOrigin, provenance: "public-demo-bootstrap:v1" };
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
