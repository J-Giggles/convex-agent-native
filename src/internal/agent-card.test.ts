import { generateAgentCard as upstreamGenerateAgentCard } from "@agent-native/core/a2a";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentCard } from "./agent-card.js";

const environmentKeys = [
	"A2A_SECRET",
	"APP_BASE_PATH",
	"AWS_LAMBDA_FUNCTION_NAME",
	"CF_PAGES",
	"FLY_APP_NAME",
	"K_SERVICE",
	"NETLIFY",
	"NETLIFY_LOCAL",
	"NODE_ENV",
	"RENDER",
	"VERCEL",
	"VERCEL_ENV",
	"VITE_APP_BASE_PATH",
] as const;
const originalEnvironment = Object.fromEntries(
	environmentKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
	for (const key of environmentKeys) {
		const value = originalEnvironment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("local AgentCard compatibility", () => {
	it.each([
		{ baseUrl: "https://example.invalid", endpoint: undefined, env: {} },
		{
			baseUrl: "https://example.invalid/base?discard=yes#fragment",
			endpoint: "/rpc/a2a",
			env: { APP_BASE_PATH: "/base" },
		},
		{
			baseUrl: "https://example.invalid",
			endpoint: "/_agent-native/a2a",
			env: { NODE_ENV: "production", A2A_SECRET: "synthetic-secret" },
		},
		{
			baseUrl: "/relative/base",
			endpoint: "custom/a2a/",
			env: { VITE_APP_BASE_PATH: "/mounted" },
		},
	])("matches the upstream public contract for %#", ({ baseUrl, endpoint, env }) => {
		for (const key of environmentKeys) delete process.env[key];
		Object.assign(process.env, env);
		const config = {
			name: "Compatibility agent",
			description: "Synthetic contract fixture",
			version: "0.1.0",
			streaming: true,
			publicSkillsOnly: true,
			apiKeyEnv: "EXAMPLE_API_KEY",
			skills: [
				{
					id: "read-example",
					name: "Read example",
					description: "Reads synthetic data",
					tags: ["read"],
				},
			],
		};
		expect(generateAgentCard(config, baseUrl, endpoint)).toEqual(
			upstreamGenerateAgentCard(config, baseUrl, endpoint),
		);
	});
});
