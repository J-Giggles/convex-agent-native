import type {
	AgentCard,
	generateAgentCard as generateUpstreamAgentCard,
} from "@agent-native/core/a2a";

/**
 * Minimal implementation of the public Agent-Native AgentCard contract used
 * by this adapter. Agent-Native and the contract are maintained by Builder.io;
 * this independent implementation intentionally avoids loading the upstream
 * application framework at runtime.
 */
export type AgentCardConfig = Parameters<typeof generateUpstreamAgentCard>[0];

function normalizeBasePath(value: string | undefined): string {
	if (!value || value === "/") return "";
	const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
	return normalized ? `/${normalized}` : "";
}

function configuredBasePath(): string {
	return normalizeBasePath(process.env.VITE_APP_BASE_PATH || process.env.APP_BASE_PATH);
}

function withConfiguredBasePath(baseUrl: string): string {
	const basePath = configuredBasePath();
	const trimmed = baseUrl.replace(/\/$/u, "");
	if (!basePath) return trimmed;
	try {
		const url = new URL(trimmed);
		const pathname = normalizeBasePath(url.pathname);
		if (pathname === basePath || pathname.startsWith(`${basePath}/`)) return trimmed;
	} catch {
		// Relative URLs use the string checks below.
	}
	if (trimmed.endsWith(basePath) || trimmed.includes(`${basePath}/`)) return trimmed;
	return `${trimmed}${basePath}`;
}

function withEndpointPath(baseUrl: string, endpointPath: string): string {
	const normalized = endpointPath.trim().split("/").filter(Boolean).join("/");
	const suffix = normalized ? `/${normalized}` : "";
	const trimmed = baseUrl.replace(/\/$/u, "");
	if (!suffix || trimmed.endsWith(suffix)) return trimmed;
	try {
		const url = new URL(trimmed);
		const pathname = url.pathname.replace(/\/$/u, "");
		if (pathname === suffix || pathname.endsWith(suffix)) return trimmed;
		url.pathname = `${pathname === "/" ? "" : pathname}${suffix}`;
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return `${trimmed}${suffix}`;
	}
}

function isProductionRuntime(): boolean {
	return (
		process.env.NODE_ENV === "production" ||
		(process.env.NETLIFY === "true" && process.env.NETLIFY_LOCAL !== "true") ||
		Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.NETLIFY_LOCAL !== "true") ||
		process.env.CF_PAGES === "1" ||
		"__cf_env" in globalThis ||
		"__env__" in globalThis ||
		Boolean(
			process.env.VERCEL ||
			process.env.VERCEL_ENV ||
			process.env.RENDER ||
			process.env.FLY_APP_NAME ||
			process.env.K_SERVICE,
		)
	);
}

export function generateAgentCard(
	config: AgentCardConfig,
	baseUrl: string,
	endpointPath = "/_agent-native/a2a",
): AgentCard {
	const card: AgentCard = {
		name: config.name,
		description: config.description,
		url: withEndpointPath(withConfiguredBasePath(baseUrl), endpointPath),
		version: config.version ?? "1.0.0",
		protocolVersion: "0.3",
		capabilities: {
			streaming: config.streaming ?? false,
			pushNotifications: false,
			stateTransitionHistory: true,
		},
		skills: config.skills,
	};
	const securitySchemes: NonNullable<AgentCard["securitySchemes"]> = {};
	const security: NonNullable<AgentCard["security"]> = [];
	if (Boolean(process.env.A2A_SECRET?.trim()) || isProductionRuntime()) {
		securitySchemes.jwtBearer = { type: "http", scheme: "bearer", bearerFormat: "JWT" };
		security.push({ jwtBearer: [] });
	}
	if (config.apiKeyEnv) {
		securitySchemes.apiKey = { type: "http", scheme: "bearer" };
		security.push({ apiKey: [] });
	}
	if (security.length > 0) {
		card.securitySchemes = securitySchemes;
		card.security = security;
	}
	return card;
}
